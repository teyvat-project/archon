import ArchonEdgeCases
import Testing

extension E2E {
    @Suite struct Responses {
        let client = Env.client()

        @Test func decodesTextPlainAsAString() async throws {
            #expect(try await client.responses.getText() == "hello, archon")
        }

        @Test func decodesOctetStreamAsBytes() async throws {
            let bytes = try await client.responses.getBinary()
            #expect(bytes.count == 256)
            #expect(bytes.first == 0x00)
            #expect(bytes.last == 0xff)
        }

        @Test func returnsWithoutDataFor204NoContent() async throws {
            #expect(try await client.responses.getEmptyWithResponse().statusCode == 204)
        }

        @Test func throwsDecodeErrorForAnEmptyBodyDeclaredAsANonOptionalObject() async throws {
            // Swift cannot return "no value" for a non-Optional type (see the README); TypeScript and C# give null.
            let error = await #expect(throws: DecodeError.self) { try await client.responses.getEmptyJson() }
            #expect(error?.statusCode == 200)
            #expect(error?.rawBody.isEmpty == true)
        }
    }
}
