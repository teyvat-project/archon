import Foundation
import Testing

@testable import ArchonRuntime

/// Records every request and answers with `handler`.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let state = Locked<[ApiRequest]>([])
    private let handler: @Sendable (ApiRequest) async throws -> ApiResponse

    init(_ handler: @escaping @Sendable (ApiRequest) async throws -> ApiResponse = { MockTransport.json(200, "{}", for: $0) }) {
        self.handler = handler
    }

    var requests: [ApiRequest] { state.current }

    var last: ApiRequest? { requests.last }

    func send(_ request: ApiRequest) async throws -> ApiResponse {
        state.withLock { $0.append(request) }
        return try await handler(request)
    }

    static func json(_ status: Int, _ body: String, for request: ApiRequest, headers: ApiHeaders = ["Content-Type": "application/json"]) -> ApiResponse {
        ApiResponse(statusCode: status, headers: headers, url: request.url, body: Data(body.utf8))
    }

    static func status(_ status: Int, for request: ApiRequest, headers: ApiHeaders = [:]) -> ApiResponse {
        ApiResponse(statusCode: status, headers: headers, url: request.url)
    }
}

/// A thread-safe list for recording from `@Sendable` closures.
final class Recorder<Element: Sendable>: @unchecked Sendable {
    private let state = Locked<[Element]>([])

    func append(_ element: Element) { state.withLock { $0.append(element) } }

    var items: [Element] { state.current }
}

/// A clock tests move by hand.
final class FakeClock: @unchecked Sendable {
    private let state = Locked(Date(timeIntervalSince1970: 1_800_000_000))

    var now: Date { state.current }

    func advance(_ seconds: TimeInterval) { state.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

struct TestAuth: AuthConfig {
    var values: [String: AuthValue] = [:]

    func value(for scheme: String) -> AuthValue? { values[scheme] }
}

struct Pet: Codable, Hashable, Sendable {
    var name: String
    var tag: String?
}

struct Problem: Codable, Hashable, Sendable {
    var code: Int
    var message: String
}

func operation(
    _ method: HTTPMethod = .get,
    _ path: String = "/pets",
    params: [ParamSpec] = [],
    security: [SecurityRequirement] = [],
    body: BodyKind? = nil,
    bodyMediaType: String? = nil,
    responses: [String: ResponseKind] = ["200": .json]
) -> OperationSpec {
    OperationSpec(
        operationName: "testOp",
        method: method,
        path: path,
        tags: ["test"],
        security: security,
        params: params,
        body: body,
        bodyMediaType: bodyMediaType,
        responses: responses
    )
}

func client(
    _ transport: MockTransport,
    baseUrl: String = "https://api.test/v1",
    auth: TestAuth? = nil,
    schemes: [String: SecuritySchemeSpec] = [:],
    middleware: [any Middleware] = [],
    timeout: Double? = nil,
    customAuth: CustomAuth? = nil
) -> ApiClientCore {
    ApiClientCore(
        options: ClientOptions(baseUrl: baseUrl, auth: auth, timeout: timeout, middleware: middleware, transport: transport, customAuth: customAuth),
        securitySchemes: schemes
    )
}

extension Data {
    var text: String { String(decoding: self, as: UTF8.self) }
}
