import ArchonEdgeCases
import Foundation
import Testing

extension E2E {
    @Suite struct Redirect {
        @Test func dropsCredentialsWhenARedirectCrossesOrigins() async throws {
            let client = Env.client(auth: ApiAuth(apiKeyHeader: "test-key"), headers: ["Authorization": "Bearer test-token"])
            let result = try await client.middleware.redirectCrossOriginWithResponse()
            #expect(result.statusCode == 200)
            let secondary = try #require(URL(string: Env.secondaryUrl))
            #expect(result.url.host == secondary.host)
            #expect(result.url.port == secondary.port)
            #expect(result.data.path == "/echo/headers")
            #expect(result.data.headers["x-api-key"] == nil)
            #expect(result.data.headers["authorization"] == nil)
        }
    }
}
