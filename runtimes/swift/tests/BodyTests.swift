import Foundation
import Testing

@testable import ArchonRuntime

private struct FormFields: Encodable {
    var name: String
    var count: Int
    var tags: [String]
    var note: String?
    var meta: [String: Int]
}

@Suite struct BodyTests {
    private func send(_ kind: BodyKind, _ mediaType: String, _ fill: (inout RequestValues) throws -> Void, options: RequestOptions? = nil) async throws -> ApiRequest {
        let transport = MockTransport()
        var values = RequestValues()
        try fill(&values)
        _ = try await client(transport).send(operation(.post, body: kind, bodyMediaType: mediaType), values, errors: .none, options: options)
        return try #require(transport.last)
    }

    @Test func encodesJsonWithTheExactMediaType() async throws {
        let request = try await send(.json, "application/vnd.api+json") { try $0.json(Pet(name: "Tama", tag: nil)) }
        #expect(request.headers["Content-Type"] == "application/vnd.api+json")
        #expect(request.body?.text == #"{"name":"Tama"}"#)
    }

    @Test func encodesFormWithRepeatedArrayFields() async throws {
        let request = try await send(.form, "application/x-www-form-urlencoded") {
            try $0.form(FormFields(name: "a b&c", count: 2, tags: ["x", "y"], note: nil, meta: ["k": 1]))
        }
        #expect(request.headers["Content-Type"] == "application/x-www-form-urlencoded")
        #expect(request.body?.text == "name=a+b%26c&count=2&tags=x&tags=y&meta=%7B%22k%22%3A1%7D")
    }

    @Test func rejectsANonObjectFormBody() async throws {
        await #expect(throws: ArgumentError.self) { try await send(.form, "application/x-www-form-urlencoded") { try $0.form([1, 2]) } }
    }

    @Test func encodesMultipartWithQuotedNamesAndFileNames() async throws {
        var multipart = MultipartBody()
        try multipart.field("title", "hello")
        try multipart.field("count", 3)
        try multipart.field("tags", ["a", "b"])
        try multipart.field("skip", nil as String?)
        multipart.file("file", ApiFile(Data("abc".utf8), fileName: "a\"b.txt", contentType: "text/plain"))
        multipart.files("more", [ApiFile(Data([1]))])
        let encoded = multipart.encoded(boundary: "B")
        #expect(encoded.contentType == "multipart/form-data; boundary=B")
        let expected = [
            "--B", #"Content-Disposition: form-data; name="title""#, "", "hello",
            "--B", #"Content-Disposition: form-data; name="count""#, "", "3",
            "--B", #"Content-Disposition: form-data; name="tags""#, "", "a",
            "--B", #"Content-Disposition: form-data; name="tags""#, "", "b",
            "--B", #"Content-Disposition: form-data; name="file"; filename="a%22b.txt""#, "Content-Type: text/plain", "", "abc",
            "--B", #"Content-Disposition: form-data; name="more"; filename="blob""#, "Content-Type: application/octet-stream", "", "\u{01}",
            "--B--", "",
        ].joined(separator: "\r\n")
        #expect(encoded.data.text == expected)

        let request = try await send(.multipart, "multipart/form-data", { $0.multipart(multipart) }, options: RequestOptions(headers: ["Content-Type": "text/plain"]))
        #expect(request.headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=archon-") == true)
    }

    @Test func sendsTextAndBinaryWithTheMediaType() async throws {
        let text = try await send(.text, "text/csv") { $0.text("a,b") }
        #expect(text.headers["Content-Type"] == "text/csv")
        #expect(text.body?.text == "a,b")
        let binary = try await send(.binary, "application/octet-stream") { $0.binary(Data([0, 1, 2])) }
        #expect(binary.headers["Content-Type"] == "application/octet-stream")
        #expect(binary.body == Data([0, 1, 2]))
        #expect(binary.replayable)
    }

    @Test func callerContentTypeWinsForNonMultipartBodies() async throws {
        let request = try await send(.json, "application/json", { try $0.json(["a": 1] as JSONValue) }, options: RequestOptions(headers: ["content-type": "application/merge-patch+json"]))
        #expect(request.headers["Content-Type"] == "application/merge-patch+json")
    }
}
