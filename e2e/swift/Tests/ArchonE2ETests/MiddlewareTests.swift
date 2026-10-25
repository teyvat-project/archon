import ArchonEdgeCases
import Foundation
import Testing

extension E2E {
    @Suite struct Middlewares {
        @Test func retries503ResponsesUntilTheEndpointSucceeds() async throws {
            let client = Env.client(middleware: [RetryMiddleware()])
            let key = "retry-\(UUID().uuidString)"
            let data = try await client.middleware.flaky(key: key, fail: 2)
            #expect(data.key == key)
            #expect(data.attempts == 3)
        }

        @Test func givesUpAfterMaxAttemptsAndThrowsTheTyped503() async throws {
            var options = RetryOptions()
            options.maxAttempts = 2
            let client = Env.client(middleware: [RetryMiddleware(options)])
            let error = await #expect(throws: ApiError.self) { try await client.middleware.flaky(key: "give-up-\(UUID().uuidString)", fail: 5) }
            #expect(error?.statusCode == 503)
            #expect(error?.body(as: ArchonEdgeCases.Error.self)?.code == 503)
        }

        @Test func reSendsOnceAfterA401WhenTheTokenWasSwappedByRetry401() async throws {
            let token = Box("expired-token")
            let swaps = Recorder<Int>()
            let retry = Retry401Middleware { context, _ in
                swaps.append(context.attempt)
                token.value = "test-token"
                return true
            }
            let client = Env.client(auth: ApiAuth(bearerAuth: TokenValue(provider: { token.value })), middleware: [retry])
            #expect(try await client.auth.authBearer().headers["authorization"] == "Bearer test-token")
            #expect(swaps.all == [1])
        }

        @Test func masksCredentialsInLogs() async throws {
            let lines = Recorder<String>()
            // Credentials the logging middleware can see: authentication itself is applied innermost, after logging.
            let withQueryKey = ClosureMiddleware { request, _, next in
                var request = request
                try request.setQueryParameter("api_key", "test-key")
                return try await next(request)
            }
            let client = Env.client(
                headers: ["Authorization": "Bearer test-token", "X-API-Key": "test-key"],
                middleware: [withQueryKey, LoggingMiddleware(includeHeaders: true, log: { lines.append($0) })]
            )
            let echo = try await client.echo.echoHeadersCookies(xRequestIds: ["r1"], theme: "dark")
            // The server did receive the credentials...
            #expect(echo.headers["authorization"] == "Bearer test-token")
            #expect(echo.headers["x-api-key"] == "test-key")
            #expect(echo.query == "api_key=test-key")

            // ...but the log did not.
            let log = lines.all
            let joined = log.joined(separator: "\n")
            #expect(!joined.contains("test-token"))
            #expect(!joined.contains("test-key"))
            #expect(!joined.contains("dark"))
            #expect(log.first == "→ GET \(Env.baseUrl)/echo/headers?api_key=***")
            let headers = log.dropFirst().dropLast().map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            #expect(headers.contains("authorization: ***"))
            #expect(headers.contains("x-api-key: ***"))
            #expect(headers.contains("cookie: ***"))
            #expect(headers.contains("x-request-ids: r1"))
            #expect(log.last?.range(of: #"^← 200 \(\d+ms\)$"#, options: .regularExpression) != nil)
        }

        @Test func setsTheUserAgent() async throws {
            let client = Env.client(middleware: [UserAgentMiddleware("archon-e2e/1.0")])
            #expect(try await client.echo.echoHeadersCookies(xRequestIds: ["r1"], theme: "dark").headers["user-agent"] == "archon-e2e/1.0")
        }

        @Test func runsMiddlewareInRegistrationOrderConfigFirstThenUse() async throws {
            let order = Recorder<String>()
            func tag(_ name: String) -> any Middleware {
                ClosureMiddleware { request, _, next in
                    order.append(">\(name)")
                    var request = request
                    request.headers["X-Trace"] = request.headers["X-Trace"].map { "\($0),\(name)" } ?? name
                    let response = try await next(request)
                    order.append("<\(name)")
                    return response
                }
            }
            let client = Env.client(middleware: [tag("a"), tag("b")])
            client.use(tag("c"))
            let echo = try await client.echo.echoHeadersCookies(xRequestIds: ["r1"], theme: "dark")
            #expect(echo.headers["x-trace"] == "a,b,c")
            #expect(order.all == [">a", ">b", ">c", "<c", "<b", "<a"])
        }
    }
}
