import ArchonEdgeCases
import Foundation
import Testing

extension E2E {
    @Suite struct Auth {
        private let clientCredentials = OAuth2ClientCredentials(clientId: "client-id", clientSecret: "client-secret")

        @Test func bearer() async throws {
            let result = try await Env.client(auth: ApiAuth(bearerAuth: "test-token")).auth.authBearerWithResponse()
            #expect(result.statusCode == 200)
            #expect(result.data.headers["authorization"] == "Bearer test-token")
        }

        @Test func basic() async throws {
            let client = Env.client(auth: ApiAuth(basicAuth: BasicValue(username: "user", password: "pass")))
            #expect(try await client.auth.authBasicWithResponse().statusCode == 200)
        }

        @Test func apiKeyInAHeader() async throws {
            #expect(try await Env.client(auth: ApiAuth(apiKeyHeader: "test-key")).auth.authApiKeyHeader().headers["x-api-key"] == "test-key")
        }

        @Test func apiKeyInTheQuery() async throws {
            let client = Env.client(auth: ApiAuth(apiKeyQuery: TokenValue(provider: { "test-key" })))
            #expect(try await client.auth.authApiKeyQuery().query == "api_key=test-key")
        }

        @Test func apiKeyInACookie() async throws {
            #expect(try await Env.client(auth: ApiAuth(apiKeyCookie: "test-key")).auth.authApiKeyCookie().cookies == ["session": "test-key"])
        }

        @Test func rejectsAWrongCredentialWithATyped401() async throws {
            let client = Env.client(auth: ApiAuth(bearerAuth: "wrong"))
            let error = await #expect(throws: ApiError.self) { try await client.auth.authBearer() }
            #expect(error?.statusCode == 401)
            let body = try #require(error?.body(as: ArchonEdgeCases.Error.self))
            #expect(body.code == 401)
            #expect(!body.message.isEmpty)
        }

        @Test func throwsAuthErrorWithoutSendingWhenRequiredAuthIsMissing() async throws {
            let before = try await Env.requestCount("/auth/bearer")
            let error = await #expect(throws: AuthError.self) { try await Env.client().auth.authBearer() }
            #expect(error?.schemes == ["bearerAuth"])
            #expect(try await Env.requestCount("/auth/bearer") == before)
        }

        @Test func sendsAnonymouslyWhenAuthIsOptionalAndNotConfigured() async throws {
            #expect(try await Env.client().auth.authOptional().headers["authorization"] == nil)
        }

        @Test func usesTheCredentialForOptionalAuthWhenItIsConfigured() async throws {
            #expect(try await Env.client(auth: ApiAuth(bearerAuth: "test-token")).auth.authOptional().headers["authorization"] == "Bearer test-token")
        }

        @Test func requiresEverySchemeOfAnAndRequirement() async throws {
            let before = try await Env.requestCount("/auth/and")
            await #expect(throws: AuthError.self) { try await Env.client(auth: ApiAuth(bearerAuth: "test-token")).auth.authAnd() }
            #expect(try await Env.requestCount("/auth/and") == before)

            let both = Env.client(auth: ApiAuth(bearerAuth: "test-token", apiKeyHeader: "test-key"))
            #expect(try await both.auth.authAndWithResponse().statusCode == 200)
        }

        @Test func oauth2ObtainsATokenWithClientCredentialsFromTheRelativeTokenUrl() async throws {
            let before = try await Env.stats()
            let client = Env.client(auth: ApiAuth(oauth2: OAuth2Value(clientCredentials: clientCredentials)))
            let echo = try await client.auth.authOAuth2()
            #expect(echo.headers["authorization"]?.hasPrefix("Bearer ") == true)
            #expect(try await Env.stats().tokensIssued == before.tokensIssued + 1)
        }

        @Test func oauth2ObtainsATokenWithTheRefreshTokenGrant() async throws {
            let refreshed = Recorder<String?>()
            let refresh = OAuth2RefreshToken(
                refreshToken: "test-refresh-token",
                clientId: "client-id",
                clientSecret: "client-secret",
                onRefreshed: { refreshed.append($0.refreshToken) }
            )
            let client = Env.client(auth: ApiAuth(oauth2: OAuth2Value(refreshToken: refresh)))
            #expect(try await client.auth.authOAuth2WithResponse().statusCode == 200)
            #expect(refreshed.all.count == 1)
            #expect(refreshed.all.first != "test-refresh-token")
        }

        @Test func oauth2RenewsTheTokenBeforeItExpiresInsteadOfWaitingForA401() async throws {
            let client = Env.client(auth: ApiAuth(oauth2: OAuth2Value(clientCredentials: clientCredentials)))
            let before = try await Env.stats()

            let first = try await client.auth.authOAuth2()
            // The token lives 2 s, well inside the 30 s renewal leeway, so each call renews it up front.
            try await Task.sleep(nanoseconds: 2_100_000_000)
            let second = try await client.auth.authOAuth2()
            #expect(first.headers["authorization"] != second.headers["authorization"])

            let after = try await Env.stats()
            #expect(after.tokensIssued - before.tokensIssued == 2)
            #expect((after.requests["/auth/oauth2"] ?? 0) - (before.requests["/auth/oauth2"] ?? 0) == 2)
        }

        @Test func oauth2IssuesASingleTokenForConcurrentRequestsOnAColdClient() async throws {
            let client = Env.client(auth: ApiAuth(oauth2: OAuth2Value(clientCredentials: clientCredentials)))
            let before = try await Env.stats()
            let headers = try await withThrowingTaskGroup(of: String?.self) { group in
                for _ in 0..<5 { group.addTask { try await client.auth.authOAuth2().headers["authorization"] } }
                return try await group.reduce(into: Set<String?>()) { $0.insert($1) }
            }
            #expect(headers.count == 1)
            #expect(try await Env.stats().tokensIssued - before.tokensIssued == 1)
        }
    }
}
