import Foundation
import Testing

@testable import ArchonRuntime

@Suite struct RedirectTests {
    private let schemes: [String: SecuritySchemeSpec] = [
        "header": .apiKey(.header, name: "X-API-Key"),
        "query": .apiKey(.query, name: "api_key"),
    ]

    private func redirecting(_ status: Int, to location: String) -> MockTransport {
        MockTransport { request in
            if request.url.host == "api.test" && request.url.path == "/start" {
                return MockTransport.status(status, for: request, headers: ["Location": location])
            }
            return MockTransport.json(200, "{}", for: request)
        }
    }

    @Test func stripsCredentialsOnACrossOriginHop() async throws {
        let transport = redirecting(302, to: "https://other.test/landing?keep=1&api_key=k")
        let core = ApiClientCore(
            options: ClientOptions(baseUrl: "https://api.test", headers: ["Authorization": "Bearer t", "X-API-Key": "k", "Cookie": "s=1", "X-Other": "o"], transport: transport),
            securitySchemes: schemes
        )
        var values = RequestValues()
        try values.query("api_key", "k")
        let op = operation(.get, "/start", params: [ParamSpec("api_key", .query, .form, explode: true)])
        let result = try await core.send(op, values, errors: .none, options: nil)
        #expect(result.url.absoluteString == "https://other.test/landing?keep=1")
        let hop = try #require(transport.last)
        #expect(hop.url.absoluteString == "https://other.test/landing?keep=1")
        #expect(hop.headers["Authorization"] == nil)
        #expect(hop.headers["X-API-Key"] == nil)
        #expect(hop.headers["Cookie"] == nil)
        #expect(hop.headers["X-Other"] == "o")
    }

    @Test func keepsHeadersOnASameOriginRedirect() async throws {
        let transport = redirecting(307, to: "/elsewhere")
        let core = ApiClientCore(options: ClientOptions(baseUrl: "https://api.test", headers: ["Authorization": "Bearer t"], transport: transport), securitySchemes: schemes)
        _ = try await core.send(operation(.get, "/start"), RequestValues(), errors: .none, options: nil)
        #expect(transport.requests.map(\.url.absoluteString) == ["https://api.test/start", "https://api.test/elsewhere"])
        #expect(transport.last?.headers["Authorization"] == "Bearer t")
    }

    @Test func seeOtherTurnsAPostIntoABodilessGet() async throws {
        let transport = redirecting(303, to: "/result")
        var values = RequestValues()
        values.text("payload")
        _ = try await client(transport, baseUrl: "https://api.test").send(operation(.post, "/start", body: .text, bodyMediaType: "text/plain"), values, errors: .none, options: nil)
        let hop = try #require(transport.last)
        #expect(hop.method == .get)
        #expect(hop.body == nil)
        #expect(hop.headers["Content-Type"] == nil)
    }

    @Test func temporaryRedirectResendsTheBody() async throws {
        let transport = redirecting(307, to: "/again")
        var values = RequestValues()
        values.text("payload")
        _ = try await client(transport, baseUrl: "https://api.test").send(operation(.post, "/start", body: .text, bodyMediaType: "text/plain"), values, errors: .none, options: nil)
        #expect(transport.last?.method == .post)
        #expect(transport.last?.body?.text == "payload")
    }

    @Test func givesUpAfterTwentyRedirects() async throws {
        let transport = MockTransport { MockTransport.status(302, for: $0, headers: ["Location": "/loop"]) }
        await #expect(throws: TransportError.self) {
            try await client(transport, baseUrl: "https://api.test").send(operation(), RequestValues(), errors: .none, options: nil)
        }
        #expect(transport.requests.count == Sender.maxRedirects + 1)
    }
}
