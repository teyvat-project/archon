import ArchonEdgeCases
import Testing

extension E2E {
    @Suite struct Errors {
        let client = Env.client()

        @Test func returnsTheSuccessBodyFor200() async throws {
            #expect(try await client.errors.getError(status: 200).ok)
        }

        @Test func throwsATypedErrorBodyFor404() async throws {
            let error = await #expect(throws: ApiError.self) { try await client.errors.getError(status: 404) }
            #expect(error?.statusCode == 404)
            let body = try #require(error?.body(as: NotFoundError.self))
            #expect(body.message == "Not found")
            #expect(body.resource == "errors/404")
        }

        @Test func throwsThe400ValidationErrorBody() async throws {
            let error = await #expect(throws: ApiError.self) { try await client.errors.getError(status: 400) }
            #expect(error?.statusCode == 400)
            let body = try #require(error?.body(as: ValidationError.self))
            #expect(body.message == "Validation failed")
            #expect(body.fields.map { "\($0.name) \($0.reason)" } == ["status invalid"])
        }

        @Test(arguments: [418, 500])
        func throwsTheDefaultErrorBodyForAnyOtherStatus(status: Int) async throws {
            let error = await #expect(throws: ApiError.self) { try await client.errors.getError(status: status) }
            #expect(error?.statusCode == status)
            #expect(error?.body(as: ArchonEdgeCases.Error.self)?.code == status)
        }
    }
}

