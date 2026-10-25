import ArchonEdgeCases
import Testing

extension E2E {
    @Suite struct Params {
        let client = Env.client()

        @Test func serializesAllPathStyles() async throws {
            let echo = try await client.echo.echoPathStyles(simple: ["a", "b"], label: ["a", "b"], matrix: EchoPathStylesMatrix(x: 1, y: 2))
            #expect(echo.method == "GET")
            #expect(echo.path == "/echo/path/a,b/.a.b/;x=1;y=2")
            #expect(echo.query == "")
        }

        @Test func percentEncodesReservedCharacters() async throws {
            let echo = try await client.echo.echoPathStyles(simple: ["a/b?c#d e", "日本"], label: ["x"], matrix: EchoPathStylesMatrix(x: 1, y: 2))
            #expect(echo.path == "/echo/path/a%2Fb%3Fc%23d%20e,%E6%97%A5%E6%9C%AC/.x/;x=1;y=2")
        }

        @Test func serializesAllQueryStyles() async throws {
            let echo = try await client.echo.echoQueryStyles(
                formExploded: ["a", "b"],
                formFlat: ["a", "b"],
                spaced: ["a", "b"],
                piped: [1, 2],
                filter: EchoQueryStylesFilter(status: "active", minAge: 3),
                reserved: "a/b?c:d",
                limit: 10
            )
            #expect(echo.path == "/echo/query")
            // `|`, `[` and `]` are percent-encoded: Foundation's URL does not accept them (see the README).
            let expected = [
                "formExploded=a&formExploded=b",
                "formFlat=a,b",
                "spaced=a%20b",
                "piped=1%7C2",
                "filter%5Bstatus%5D=active&filter%5BminAge%5D=3",
                "reserved=a/b?c:d",
                "limit=10",
            ]
            #expect(echo.query == expected.joined(separator: "&"))
        }

        @Test func omitsUnsetQueryParameters() async throws {
            #expect(try await client.echo.echoQueryStyles(limit: 1).query == "limit=1")
        }

        @Test func sendsHeaderArrayAndCookies() async throws {
            let echo = try await client.echo.echoHeadersCookies(xRequestIds: ["a", "b"], theme: "dark", xTrace: "trace-1", tags: ["x", "y"])
            #expect(echo.headers["x-request-ids"] == "a,b")
            #expect(echo.headers["x-trace"] == "trace-1")
            #expect(echo.headers["cookie"] == "theme=dark; tags=x,y")
            #expect(echo.cookies == ["theme": "dark", "tags": "x,y"])
        }
    }
}
