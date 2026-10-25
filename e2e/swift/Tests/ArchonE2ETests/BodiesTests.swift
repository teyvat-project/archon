import ArchonEdgeCases
import Foundation
import Testing

extension E2E {
    @Suite struct Bodies {
        let client = Env.client()

        @Test func sendsAJsonBody() async throws {
            let payload = JsonPayload(name: "archon", count: 3, tags: ["a", "b"], note: nil, nested: Nested(flag: true))
            let echo = try await client.echo.echoJson(body: payload)
            #expect(echo.method == "POST")
            #expect(echo.contentType == "application/json")
            let body = try #require(echo.body)
            #expect(try ApiJSON.decode(JsonPayload.self, from: Data(body.utf8)) == payload)
            // Optional nils are not written (the "unset" vs "null" distinction is out of scope).
            #expect(!body.contains("note"))
        }

        @Test func sendsAUrlEncodedFormBodyWithRepeatedArrayFields() async throws {
            let echo = try await client.echo.echoForm(body: EchoFormBody(name: "a b&c", count: 2, tags: ["x", "y"]))
            #expect(echo.contentType == "application/x-www-form-urlencoded")
            #expect(echo.body == "name=a+b%26c&count=2&tags=x&tags=y")
        }

        @Test func sendsAMultipartBodyWithFileNamesAndSizes() async throws {
            let echo = try await client.echo.echoMultipart(
                body: EchoMultipartBody(
                    title: "hello",
                    file: ApiFile(Data(count: 10), fileName: "data.bin", contentType: "application/octet-stream"),
                    attachments: [ApiFile(Data("abc".utf8), fileName: "a.txt"), ApiFile(Data("hello".utf8), fileName: "b.txt")]
                )
            )
            #expect(echo.contentType?.hasPrefix("multipart/form-data; boundary=") == true)
            #expect(echo.body == #"{"title":"hello"}"#)
            let files = (echo.files ?? []).map { "\($0.field) \($0.name) \($0.size)" }
            #expect(files == ["file data.bin 10", "attachments a.txt 3", "attachments b.txt 5"])
        }

        @Test func sendsABinaryBody() async throws {
            let echo = try await client.echo.echoBinary(body: Data("raw bytes".utf8))
            #expect(echo.contentType == "application/octet-stream")
            #expect(echo.headers["content-length"] == "9")
            #expect(echo.body == "raw bytes")
        }

        @Test func sendsAPlainTextBody() async throws {
            let echo = try await client.echo.echoText(body: "hello, text")
            #expect(echo.contentType == "text/plain")
            #expect(echo.body == "hello, text")
        }

        @Test func roundTripsARecursiveAllOfTreeTheServerAssigningIds() async throws {
            let tree = Node(
                name: "root",
                labels: ["env": "test"],
                id: "placeholder",
                children: [
                    Node(name: "a", id: "placeholder", children: [Node(name: "a1", id: "placeholder", children: [])]),
                    Node(name: "b", id: "placeholder", children: []),
                ]
            )
            let result = try await client.nodes.createNodeWithResponse(body: tree)
            #expect(result.statusCode == 201)
            let root = result.data
            #expect(root.id == "n1")
            #expect(root.parentId == nil)
            #expect(root.name == "root")
            #expect(root.labels?["env"] == "test")
            #expect(root.children.map(\.id) == ["n2", "n4"])
            #expect(root.children.allSatisfy { $0.parentId == "n1" })
            let a1 = try #require(root.children.first?.children.first)
            #expect(root.children[0].children.count == 1)
            #expect([a1.id, a1.parentId, a1.name] == ["n3", "n2", "a1"])
            #expect(root.children[1].children.isEmpty)
        }
    }
}
