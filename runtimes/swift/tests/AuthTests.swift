import Foundation
import Testing

@testable import ArchonRuntime

private let schemes: [String: SecuritySchemeSpec] = [
    "bearer": .httpBearer,
    "basic": .httpBasic,
    "header": .apiKey(.header, name: "X-API-Key"),
    "query": .apiKey(.query, name: "api_key"),
    "cookie": .apiKey(.cookie, name: "session"),
    "oauth": .oauth2(tokenUrl: "/oauth/token", refreshUrl: nil),
]

private func requirement(_ names: String...) -> SecurityRequirement {
    SecurityRequirement(names.map { SecurityScheme($0) })
}

@Suite struct AuthTests {
    @Test func selectsTheFirstSatisfiableAlternative() {
        let configured: Set<String> = ["b"]
        let select = { (requirements: [SecurityRequirement]) in SecuritySelector.select(requirements) { configured.contains($0) } }
        #expect(select([]) == .anonymous)
        #expect(select([requirement("a"), requirement()]) == .anonymous)
        #expect(select([requirement("a")]) == .missing(["a"]))
        #expect(select([requirement("a", "b"), requirement("b")]) == .apply(requirement("b")))
        #expect(select([requirement("a", "b"), requirement("c")]) == .missing(["a"]))
    }

    private func send(_ auth: TestAuth, _ security: [SecurityRequirement], transport: MockTransport = MockTransport(), customAuth: CustomAuth? = nil) async throws -> ApiRequest {
        let core = client(transport, auth: auth, schemes: schemes, customAuth: customAuth)
        var values = RequestValues()
        try values.query("q", "1")
        try values.cookie("theme", "dark")
        let op = operation(params: [ParamSpec("q", .query, .form, explode: true), ParamSpec("theme", .cookie, .form, explode: true)], security: security)
        _ = try await core.send(op, values, errors: .none, options: nil)
        return try #require(transport.last)
    }

    @Test func appliesBearerFromAnAsyncProvider() async throws {
        let request = try await send(TestAuth(values: ["bearer": .token(TokenValue(provider: { "dyn" }))]), [requirement("bearer")])
        #expect(request.headers["Authorization"] == "Bearer dyn")
    }

    @Test func appliesBasicAsUtf8() async throws {
        let request = try await send(TestAuth(values: ["basic": .basic(BasicValue(username: "user", password: "päss"))]), [requirement("basic")])
        #expect(request.headers["Authorization"] == "Basic dXNlcjpww6Rzcw==")
    }

    @Test func appliesApiKeysInHeaderQueryAndCookie() async throws {
        let auth = TestAuth(values: ["header": .token("h"), "query": .token("q k"), "cookie": .token("c;1")])
        let request = try await send(auth, [requirement("header", "query", "cookie")])
        #expect(request.headers["X-API-Key"] == "h")
        #expect(request.url.query == "q=1&api_key=q%20k")
        #expect(request.headers["Cookie"] == "theme=dark; session=c%3B1")
    }

    @Test func throwsAuthErrorBeforeSending() async throws {
        let transport = MockTransport()
        let error = await #expect(throws: AuthError.self) { try await send(TestAuth(), [requirement("bearer")], transport: transport) }
        #expect(error?.schemes == ["bearer"])
        #expect(transport.requests.isEmpty)
    }

    @Test func mismatchedValueKindsDoNotCount() async throws {
        await #expect(throws: AuthError.self) { try await send(TestAuth(values: ["basic": .token("t")]), [requirement("basic")]) }
        await #expect(throws: AuthError.self) { try await send(TestAuth(values: ["oauth": .oauth2(OAuth2Value())]), [requirement("oauth")]) }
    }

    @Test func reappliesAFreshTokenWhenMiddlewareSendsAgain() async throws {
        let counter = Locked(0)
        let auth = TestAuth(values: ["bearer": .token(TokenValue(provider: { "t\(counter.withLock { $0 += 1; return $0 })" }))])
        let twice = ClosureMiddleware { request, _, next in
            _ = try await next(request)
            return try await next(request)
        }
        let transport = MockTransport()
        let core = client(transport, auth: auth, schemes: schemes, middleware: [twice])
        _ = try await core.send(operation(security: [requirement("bearer")]), RequestValues(), errors: .none, options: nil)
        #expect(transport.requests.map { $0.headers["Authorization"] } == ["Bearer t1", "Bearer t2"])
    }

    @Test func retriesOnceOn401WithAManagedToken() async throws {
        let issued = Locked(0)
        let transport = MockTransport { request in
            if request.url.path == "/oauth/token" {
                let n = issued.withLock { $0 += 1; return $0 }
                return MockTransport.json(200, #"{"access_token":"tok\#(n)","expires_in":3600}"#, for: request)
            }
            return MockTransport.status(request.headers["Authorization"] == "Bearer tok1" ? 401 : 200, for: request)
        }
        let auth = TestAuth(values: ["oauth": .oauth2(OAuth2Value(clientCredentials: OAuth2ClientCredentials(clientId: "id", clientSecret: "secret")))])
        let request = try await send(auth, [SecurityRequirement([SecurityScheme("oauth", scopes: ["read"])])], transport: transport)
        #expect(request.headers["Authorization"] == "Bearer tok2")
        #expect(issued.current == 2)
        #expect(transport.requests.filter { $0.url.path == "/v1/pets" }.count == 2)
    }

    @Test func customAuthCoversUnknownSchemes() async throws {
        let request = try await send(TestAuth(), [requirement("digest")], customAuth: { request, _ in request.headers.set("Authorization", "Digest x") })
        #expect(request.headers["Authorization"] == "Digest x")
    }
}

@Suite struct OAuth2TokenManagerTests {
    private func tokenServer(expiresIn: Int = 3600, delay: UInt64 = 0, status: Int = 200, body: String? = nil) -> (MockTransport, Locked<Int>) {
        let issued = Locked(0)
        let transport = MockTransport { request in
            if delay > 0 { try await Task.sleep(nanoseconds: delay) }
            let n = issued.withLock { $0 += 1; return $0 }
            return MockTransport.json(status, body ?? #"{"access_token":"tok\#(n)","expires_in":\#(expiresIn),"refresh_token":"r\#(n)"}"#, for: request)
        }
        return (transport, issued)
    }

    private let credentials = OAuth2Value(clientCredentials: OAuth2ClientCredentials(clientId: "id", clientSecret: "secret", scopes: ["write"]))

    @Test func fetchesClientCredentialsWithBasicClientAuth() async throws {
        let (transport, _) = tokenServer()
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        #expect(try await manager.token(scopes: ["read", "write"]) == "tok1")
        let request = try #require(transport.last)
        #expect(request.method == .post)
        #expect(request.url.absoluteString == "https://auth.test/token")
        #expect(request.headers["Authorization"] == "Basic aWQ6c2VjcmV0")
        #expect(request.headers["Content-Type"] == "application/x-www-form-urlencoded")
        #expect(request.body?.text == "grant_type=client_credentials&scope=read+write")
    }

    @Test func postsClientCredentialsInTheFormWhenAsked() async throws {
        let (transport, _) = tokenServer()
        let config = OAuth2Value(clientCredentials: OAuth2ClientCredentials(clientId: "id", clientSecret: "s&s", clientAuth: .post))
        let manager = OAuth2TokenManager(transport: transport, config: config, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        _ = try await manager.token(scopes: [])
        #expect(transport.last?.headers["Authorization"] == nil)
        #expect(transport.last?.body?.text == "grant_type=client_credentials&client_id=id&client_secret=s%26s")
    }

    @Test func cachesUntil30SecondsBeforeExpiry() async throws {
        let (transport, issued) = tokenServer(expiresIn: 100)
        let clock = FakeClock()
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth", now: { clock.now })
        #expect(try await manager.token(scopes: []) == "tok1")
        clock.advance(69)
        #expect(try await manager.token(scopes: []) == "tok1")
        clock.advance(2)
        #expect(try await manager.token(scopes: []) == "tok2")
        #expect(issued.current == 2)
    }

    @Test func singleFlightForConcurrentCalls() async throws {
        let (transport, issued) = tokenServer(delay: 50_000_000)
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        let tokens = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<5 { group.addTask { try await manager.token(scopes: ["read"]) } }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(Set(tokens) == ["tok1"])
        #expect(issued.current == 1)
    }

    @Test func aCancelledWaiterDoesNotCancelTheSharedFetch() async throws {
        let (transport, issued) = tokenServer(delay: 200_000_000)
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        let cancelled = Task { try await manager.token(scopes: []) }
        let others = (0..<4).map { _ in Task { try await manager.token(scopes: []) } }
        try await Task.sleep(nanoseconds: 50_000_000)
        cancelled.cancel()
        await #expect(throws: CancellationError.self) { try await cancelled.value }
        for other in others { #expect(try await other.value == "tok1") }
        #expect(issued.current == 1)
    }

    @Test func refreshGrantRotatesTheTokenAndCallsOnRefreshed() async throws {
        let (transport, _) = tokenServer()
        let rotated = Recorder<String>()
        let config = OAuth2Value(refreshToken: OAuth2RefreshToken(refreshToken: "r0", clientId: "id", onRefreshed: { rotated.append($0.refreshToken ?? "-") }))
        let manager = OAuth2TokenManager(transport: transport, config: config, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        _ = try await manager.token(scopes: ["read"])
        #expect(transport.last?.body?.text == "grant_type=refresh_token&refresh_token=r0&client_id=id")
        await manager.invalidate()
        _ = try await manager.token(scopes: [])
        #expect(transport.last?.body?.text == "grant_type=refresh_token&refresh_token=r1&client_id=id")
        #expect(rotated.items == ["r1", "r2"])
    }

    @Test func invalidateOnlyDropsTheRejectedToken() async throws {
        let (transport, _) = tokenServer()
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
        _ = try await manager.token(scopes: [])
        await manager.invalidate("stale")
        #expect(try await manager.token(scopes: []) == "tok1")
        await manager.invalidate("tok1")
        #expect(try await manager.token(scopes: []) == "tok2")
    }

    @Test func resolvesARelativeTokenUrlAgainstTheBaseUrl() async throws {
        let (transport, _) = tokenServer()
        let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "/oauth/token", baseUrl: "https://api.test/v1/", scheme: "oauth")
        _ = try await manager.token(scopes: [])
        #expect(transport.last?.url.absoluteString == "https://api.test/oauth/token")
    }

    @Test func failsWithAuthErrorWhenTheTokenEndpointFails() async throws {
        for (status, body) in [(500, "{}"), (200, "not json"), (200, #"{"token_type":"bearer"}"#)] {
            let (transport, _) = tokenServer(status: status, body: body)
            let manager = OAuth2TokenManager(transport: transport, config: credentials, tokenUrl: "https://auth.test/token", baseUrl: nil, scheme: "oauth")
            let error = await #expect(throws: AuthError.self) { try await manager.token(scopes: []) }
            #expect(error?.schemes == ["oauth"])
        }
    }
}
