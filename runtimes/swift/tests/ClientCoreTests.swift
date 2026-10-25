import Foundation
import Testing

@testable import ArchonRuntime

@Suite struct ClientCoreTests {
    @Test func buildsUrlKeepingTheBasePathAndQuery() async throws {
        let transport = MockTransport()
        let core = client(transport, baseUrl: "https://api.test/v1/?tenant=a")
        var values = RequestValues()
        try values.path("id", "a%2Fb")
        try values.query("q", "x y")
        let op = operation(.get, "/pets/{id}", params: [ParamSpec("id", .path, .simple, explode: false), ParamSpec("q", .query, .form, explode: true)])
        _ = try await core.send(op, values, decoder: .json(JSONValue.self), errors: .none, options: nil)
        // `%` of the value is encoded once and the URL is not re-encoded.
        #expect(transport.last?.url.absoluteString == "https://api.test/v1/pets/a%252Fb?tenant=a&q=x%20y")
    }

    @Test func keepsPipesAndBracketsEncodedOnTheWire() async throws {
        let transport = MockTransport()
        var values = RequestValues()
        try values.query("piped", [1, 2])
        try values.query("filter", ["a": "b"] as JSONValue)
        let op = operation(params: [ParamSpec("piped", .query, .pipeDelimited, explode: false), ParamSpec("filter", .query, .deepObject, explode: true)])
        _ = try await client(transport).send(op, values, decoder: .json(JSONValue.self), errors: .none, options: nil)
        #expect(transport.last?.url.query == "piped=1%7C2&filter%5Ba%5D=b")
    }

    @Test func rejectsARelativeBaseUrl() async throws {
        let core = client(MockTransport(), baseUrl: "/api")
        await #expect(throws: ArgumentError.self) {
            try await core.send(operation(), RequestValues(), decoder: .json(JSONValue.self), errors: .none, options: nil)
        }
    }

    @Test func ordersHeadersAndSetsAcceptAndCookies() async throws {
        let transport = MockTransport()
        let core = ApiClientCore(
            options: ClientOptions(baseUrl: "https://api.test", headers: ["X-Client": "c", "X-Trace": "client"], transport: transport),
            securitySchemes: [:]
        )
        var values = RequestValues()
        try values.header("X-Trace", "param")
        try values.cookie("theme", "dark")
        let op = operation(params: [ParamSpec("X-Trace", .header, .simple, explode: false), ParamSpec("theme", .cookie, .form, explode: true)])
        _ = try await core.send(op, values, decoder: .json(JSONValue.self), errors: .none, options: RequestOptions(headers: ["X-Extra": "e", "Cookie": "a=1"]))
        let headers = try #require(transport.last?.headers)
        #expect(headers.map(\.name) == ["X-Client", "X-Trace", "X-Extra", "Cookie", "Accept"])
        #expect(headers["X-Trace"] == "param")
        #expect(headers["Cookie"] == "a=1; theme=dark")
        #expect(headers["Accept"] == "application/json")

        _ = try await core.send(operation(responses: ["200": .text]), RequestValues(), decoder: .text, errors: .none, options: nil)
        #expect(transport.last?.headers["Accept"] == "*/*")
    }

    @Test func returnsTypedDataStatusAndHeaders() async throws {
        let transport = MockTransport { .init(statusCode: 201, headers: ["X-Id": "7"], url: $0.url, body: Data(#"{"name":"Tama","tag":null,"extra":1}"#.utf8)) }
        let result = try await client(transport).send(operation(responses: ["201": .json]), RequestValues(), decoder: .json(Pet.self), errors: .none, options: nil)
        #expect(result.data == Pet(name: "Tama", tag: nil))
        #expect(result.statusCode == 201)
        #expect(result.headers["x-id"] == "7")
    }

    @Test func throwsApiErrorWithTheBodyTypeOfTheStatus() async throws {
        let transport = MockTransport { MockTransport.json(404, #"{"code":404,"message":"nope"}"#, for: $0) }
        let errors = ErrorDecoders().json("404", Problem.self).text("5XX")
        let error = await #expect(throws: ApiError.self) {
            try await client(transport).send(operation(), RequestValues(), decoder: .json(Pet.self), errors: errors, options: nil)
        }
        #expect(error?.statusCode == 404)
        #expect(error?.body(as: Problem.self) == Problem(code: 404, message: "nope"))
        #expect(error?.rawText == #"{"code":404,"message":"nope"}"#)
    }

    @Test func fallsBackToRangeAndDefaultErrorDecoders() async throws {
        let errors = ErrorDecoders().text("5XX").json("default", Problem.self)
        let server = MockTransport { MockTransport.json(503, "busy", for: $0) }
        let first = await #expect(throws: ApiError.self) { try await client(server).send(operation(), RequestValues(), errors: errors, options: nil) }
        #expect(first?.body(as: String.self) == "busy")

        let teapot = MockTransport { MockTransport.json(418, "not json", for: $0) }
        let second = await #expect(throws: ApiError.self) { try await client(teapot).send(operation(), RequestValues(), errors: errors, options: nil) }
        #expect(second?.body == nil)
        #expect(second?.rawText == "not json")
    }

    @Test func emptyJsonIsNilForOptionalTypesAndADecodeErrorOtherwise() async throws {
        let empty = MockTransport { MockTransport.status(204, for: $0) }
        let optional = try await client(empty).send(operation(), RequestValues(), decoder: .json(Pet?.self), errors: .none, options: nil)
        #expect(optional.data == nil)
        let error = await #expect(throws: DecodeError.self) {
            try await client(empty).send(operation(), RequestValues(), decoder: .json(Pet.self), errors: .none, options: nil)
        }
        #expect(error?.statusCode == 204)
        let noContent = try await client(empty).send(operation(responses: ["204": .empty]), RequestValues(), errors: .none, options: nil)
        #expect(noContent.statusCode == 204)
    }

    @Test func throwsDecodeErrorForInvalidJson() async throws {
        let transport = MockTransport { MockTransport.json(200, "{oops", for: $0) }
        let error = await #expect(throws: DecodeError.self) {
            try await client(transport).send(operation(), RequestValues(), decoder: .json(Pet.self), errors: .none, options: nil)
        }
        #expect(error?.rawBody.text == "{oops")
    }

    @Test func decodesTextAndBinary() async throws {
        let transport = MockTransport { .init(statusCode: 200, url: $0.url, body: Data([0, 255])) }
        let bytes = try await client(transport).send(operation(responses: ["200": .binary]), RequestValues(), decoder: .binary, errors: .none, options: nil)
        #expect(bytes.data == Data([0, 255]))
        let text = MockTransport { .init(statusCode: 200, url: $0.url, body: Data("héllo".utf8)) }
        #expect(try await client(text).send(operation(), RequestValues(), decoder: .text, errors: .none, options: nil).data == "héllo")
    }

    @Test func timesOutWithTransportError() async throws {
        let transport = MockTransport { request in
            try await Task.sleep(nanoseconds: 2_000_000_000)
            return MockTransport.status(200, for: request)
        }
        let error = await #expect(throws: TransportError.self) {
            try await client(transport, timeout: 0.05).send(operation(), RequestValues(), errors: .none, options: nil)
        }
        #expect(error?.timedOut == true)
    }

    @Test func callerCancellationThrowsCancellationError() async throws {
        let transport = MockTransport { request in
            try await Task.sleep(nanoseconds: 2_000_000_000)
            return MockTransport.status(200, for: request)
        }
        let task = Task { try await client(transport, timeout: 10).send(operation(), RequestValues(), errors: .none, options: nil) }
        try await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
    }

    @Test func runsMiddlewareOuterToInnerWithAuthInnermost() async throws {
        let order = Recorder<String>()
        func tag(_ name: String) -> any Middleware {
            ClosureMiddleware { request, context, next in
                order.append("\(name):before")
                let response = try await next(request)
                order.append("\(name):after")
                return response
            }
        }
        let transport = MockTransport { request in
            order.append("send auth=\(request.headers["Authorization"] ?? "-")")
            return MockTransport.json(200, "{}", for: request)
        }
        let core = client(
            transport,
            auth: TestAuth(values: ["bearer": .token("t")]),
            schemes: ["bearer": .httpBearer],
            middleware: [tag("mw1")]
        )
        core.use(tag("mw2"))
        let op = operation(security: [SecurityRequirement([SecurityScheme("bearer")])])
        _ = try await core.send(op, RequestValues(), decoder: .json(JSONValue.self), errors: .none, options: nil)
        #expect(order.items == ["mw1:before", "mw2:before", "send auth=Bearer t", "mw2:after", "mw1:after"])
    }

    @Test func passesExtensionsAndAttemptToMiddleware() async throws {
        let seen = Recorder<String>()
        let probe = ClosureMiddleware { request, context, next in
            seen.append("\(context.operationName) \(context.method.rawValue) \(context.pathTemplate) \(context.attempt) \(context.extensions["k"] as? String ?? "-")")
            return try await next(request)
        }
        let core = client(MockTransport(), middleware: [probe])
        _ = try await core.send(operation(), RequestValues(), errors: .none, options: RequestOptions(extensions: ["k": "v"]))
        #expect(seen.items == ["testOp GET /pets 1 v"])
    }

    @Test func requestOptionsBaseUrlOverridesTheClient() async throws {
        let transport = MockTransport()
        _ = try await client(transport).send(operation(), RequestValues(), errors: .none, options: RequestOptions(baseUrl: "http://other.test:8080/"))
        #expect(transport.last?.url.absoluteString == "http://other.test:8080/pets")
    }

    @Test func replacingOptionsTakesEffectForTheNextCall() async throws {
        let transport = MockTransport()
        let core = client(transport)
        core.options.headers["X-Late"] = "1"
        _ = try await core.send(operation(), RequestValues(), errors: .none, options: nil)
        #expect(transport.last?.headers["X-Late"] == "1")
    }
}
