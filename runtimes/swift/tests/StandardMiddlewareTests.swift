import Foundation
import Testing

@testable import ArchonRuntime

private func retryOptions(_ configure: (inout RetryOptions) -> Void = { _ in }, delays: Recorder<Double>) -> RetryOptions {
    var options = RetryOptions()
    options.sleep = { delays.append($0) }
    options.random = { 0.5 }
    configure(&options)
    return options
}

/// Answers with the statuses in order (then 200), counting requests.
private func sequence(_ statuses: [Int], headers: ApiHeaders = [:]) -> MockTransport {
    let index = Locked(0)
    return MockTransport { request in
        let i = index.withLock { i in defer { i += 1 }; return i }
        return MockTransport.status(i < statuses.count ? statuses[i] : 200, for: request, headers: headers)
    }
}

@Suite struct StandardMiddlewareTests {
    @Test func retries503HonouringRetryAfterSeconds() async throws {
        let delays = Recorder<Double>()
        let transport = sequence([503], headers: ["Retry-After": "1"])
        let attempts = Recorder<Int>()
        let probe = ClosureMiddleware { request, context, next in
            attempts.append(context.attempt)
            return try await next(request)
        }
        let core = client(transport, middleware: [RetryMiddleware(retryOptions(delays: delays)), probe])
        let result = try await core.send(operation(), RequestValues(), errors: .none, options: nil)
        #expect(result.statusCode == 200)
        #expect(delays.items == [1])
        #expect(attempts.items == [1, 2])
    }

    @Test func doesNotRetryPostByDefaultOrNonReplayableRequests() async throws {
        let delays = Recorder<Double>()
        let post = sequence([503])
        await #expect(throws: ApiError.self) {
            try await client(post, middleware: [RetryMiddleware(retryOptions(delays: delays))]).send(operation(.post), RequestValues(), errors: .none, options: nil)
        }
        #expect(post.requests.count == 1)

        let stream = sequence([503])
        let notReplayable = ClosureMiddleware { request, _, next in
            var request = request
            request.replayable = false
            return try await next(request)
        }
        await #expect(throws: ApiError.self) {
            try await client(stream, middleware: [notReplayable, RetryMiddleware(retryOptions(delays: delays))]).send(operation(), RequestValues(), errors: .none, options: nil)
        }
        #expect(stream.requests.count == 1)
    }

    @Test func stopsAfterMaxAttemptsWithExponentialBackoff() async throws {
        let delays = Recorder<Double>()
        let transport = sequence([500, 500, 500, 500])
        let error = await #expect(throws: ApiError.self) {
            try await client(transport, middleware: [RetryMiddleware(retryOptions({ $0.maxAttempts = 3 }, delays: delays))]).send(operation(), RequestValues(), errors: .none, options: nil)
        }
        #expect(error?.statusCode == 500)
        #expect(transport.requests.count == 3)
        // min(5, 0.2 * 2^(n-1)) * (0.5 + 0.5 / 2)
        #expect(delays.items.map { ($0 * 1000).rounded() } == [150, 300])
    }

    @Test func retriesNetworkErrorsButNotTimeouts() async throws {
        let delays = Recorder<Double>()
        let failures = Locked(0)
        let flaky = MockTransport { request in
            if failures.withLock({ $0 += 1; return $0 }) == 1 { throw TransportError("connection reset") }
            return MockTransport.status(200, for: request)
        }
        #expect(try await client(flaky, middleware: [RetryMiddleware(retryOptions(delays: delays))]).send(operation(), RequestValues(), errors: .none, options: nil).statusCode == 200)

        let slow = MockTransport { request in
            try await Task.sleep(nanoseconds: 1_000_000_000)
            return MockTransport.status(200, for: request)
        }
        await #expect(throws: TransportError.self) {
            try await client(slow, middleware: [RetryMiddleware(retryOptions(delays: delays))], timeout: 0.02).send(operation(), RequestValues(), errors: .none, options: nil)
        }
        #expect(slow.requests.count == 1)
    }

    @Test func equalJitterStaysWithinBounds() {
        for random in [0.0, 0.999] {
            var options = RetryOptions()
            options.random = { random }
            let delay = RetryMiddleware(options).backoff(3)
            #expect(delay >= 0.4 && delay <= 0.8)
        }
    }

    @Test func parsesRetryAfterDates() {
        var options = RetryOptions()
        options.now = { Date(timeIntervalSince1970: 784_111_777) }  // Sun, 06 Nov 1994 08:49:37 GMT
        let retry = RetryMiddleware(options)
        #expect(retry.parseRetryAfter("Sun, 06 Nov 1994 08:49:47 GMT") == 10)
        #expect(retry.parseRetryAfter("1.5") == nil)
        #expect(retry.parseRetryAfter(nil) == nil)
    }

    @Test func retry401ResendsOnceWithFreshCredentials() async throws {
        let token = Locked("old")
        let transport = MockTransport { MockTransport.status($0.headers["Authorization"] == "Bearer new" ? 200 : 401, for: $0) }
        let calls = Recorder<Int>()
        let retry = Retry401Middleware { context, _ in
            calls.append(context.attempt)
            token.withLock { $0 = "new" }
            return true
        }
        let core = client(
            transport,
            auth: TestAuth(values: ["bearer": .token(TokenValue(provider: { token.current }))]),
            schemes: ["bearer": .httpBearer],
            middleware: [retry]
        )
        let result = try await core.send(operation(security: [SecurityRequirement([SecurityScheme("bearer")])]), RequestValues(), errors: .none, options: nil)
        #expect(result.statusCode == 200)
        #expect(calls.items == [1])
        #expect(transport.requests.count == 2)
    }

    @Test func loggingMasksCredentials() async throws {
        let lines = Recorder<String>()
        let transport = MockTransport()
        let core = ApiClientCore(
            options: ClientOptions(
                baseUrl: "https://api.test",
                headers: ["Authorization": "Bearer secret", "X-API-Key": "key", "Cookie": "s=1", "X-Custom": "c", "X-Visible": "v"],
                middleware: [LoggingMiddleware(includeHeaders: true, redactHeaders: ["X-Custom"], log: { lines.append($0) })],
                transport: transport
            ),
            securitySchemes: ["key": .apiKey(.header, name: "X-API-Key"), "q": .apiKey(.query, name: "api_key")]
        )
        var values = RequestValues()
        try values.query("api_key", "key")
        try values.query("page", 2)
        _ = try await core.send(operation(params: [ParamSpec("api_key", .query, .form, explode: true), ParamSpec("page", .query, .form, explode: true)]), values, errors: .none, options: nil)
        let log = lines.items
        #expect(log.first == "→ GET https://api.test/pets?api_key=***&page=2")
        #expect(log.contains("  Authorization: ***"))
        #expect(log.contains("  X-API-Key: ***"))
        #expect(log.contains("  Cookie: ***"))
        #expect(log.contains("  X-Custom: ***"))
        #expect(log.contains("  X-Visible: v"))
        #expect(!log.joined().contains("secret"))
        #expect(log.last?.range(of: #"^← 200 \(\d+ms\)$"#, options: .regularExpression) != nil)
    }

    @Test func userAgentSetsTheHeader() async throws {
        let transport = MockTransport()
        _ = try await client(transport, middleware: [UserAgentMiddleware("archon/1.0")]).send(operation(), RequestValues(), errors: .none, options: nil)
        #expect(transport.last?.headers["User-Agent"] == "archon/1.0")
    }
}
