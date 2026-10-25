import Foundation
import Testing

@testable import ArchonRuntime

private let string: JSONValue = "blue"
private let array: JSONValue = ["blue", "black", "brown"]
private let object: JSONValue = ["R": 100, "G": 200, "B": 150]

private func values(_ location: ParamLocation, _ entries: [(String, JSONValue)]) throws -> RequestValues {
    var values = RequestValues()
    for (name, value) in entries {
        switch location {
        case .path: try values.path(name, value)
        case .query: try values.query(name, value)
        case .header: try values.header(name, value)
        case .cookie: try values.cookie(name, value)
        }
    }
    return values
}

private struct Row: Sendable, CustomTestStringConvertible {
    var style: ParamStyle
    var explode: Bool
    var string: String?
    var array: String?
    var object: String?
    var testDescription: String { "\(style) explode=\(explode)" }
}

// RFC 6570 / OpenAPI 3.x style examples table (the TypeScript runtime's), with `|` and `[` `]` percent-encoded.
private let pathRows: [Row] = [
    Row(style: .matrix, explode: false, string: ";color=blue", array: ";color=blue,black,brown", object: ";color=R,100,G,200,B,150"),
    Row(style: .matrix, explode: true, string: ";color=blue", array: ";color=blue;color=black;color=brown", object: ";R=100;G=200;B=150"),
    Row(style: .label, explode: false, string: ".blue", array: ".blue,black,brown", object: ".R,100,G,200,B,150"),
    Row(style: .label, explode: true, string: ".blue", array: ".blue.black.brown", object: ".R=100.G=200.B=150"),
    Row(style: .simple, explode: false, string: "blue", array: "blue,black,brown", object: "R,100,G,200,B,150"),
    Row(style: .simple, explode: true, string: "blue", array: "blue,black,brown", object: "R=100,G=200,B=150"),
]

private let queryRows: [Row] = [
    Row(style: .form, explode: false, string: "color=blue", array: "color=blue,black,brown", object: "color=R,100,G,200,B,150"),
    Row(style: .form, explode: true, string: "color=blue", array: "color=blue&color=black&color=brown", object: "R=100&G=200&B=150"),
    Row(style: .spaceDelimited, explode: false, array: "color=blue%20black%20brown", object: "color=R%20100%20G%20200%20B%20150"),
    Row(style: .pipeDelimited, explode: false, array: "color=blue%7Cblack%7Cbrown", object: "color=R%7C100%7CG%7C200%7CB%7C150"),
    Row(style: .deepObject, explode: true, object: "color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150"),
]

@Suite struct ParameterSerializerTests {
    @Test(arguments: pathRows)
    fileprivate func pathStyles(row: Row) throws {
        let specs = [ParamSpec("color", .path, row.style, explode: row.explode)]
        let run = { (value: JSONValue) in try ParameterSerializer.path("{color}", specs, values(.path, [("color", value)])) }
        #expect(try run(string) == row.string)
        #expect(try run(array) == row.array)
        #expect(try run(object) == row.object)
    }

    @Test(arguments: queryRows)
    fileprivate func queryStyles(row: Row) throws {
        let specs = [ParamSpec("color", .query, row.style, explode: row.explode)]
        let run = { (value: JSONValue) in ParameterSerializer.query(specs, try values(.query, [("color", value)])) }
        if let expected = row.string { #expect(try run(string) == expected) }
        if let expected = row.array { #expect(try run(array) == expected) }
        if let expected = row.object { #expect(try run(object) == expected) }
    }

    @Test func substitutesEveryPlaceholder() throws {
        let specs = [ParamSpec("owner", .path, .simple, explode: false), ParamSpec("id", .path, .simple, explode: false)]
        let path = try ParameterSerializer.path("/repos/{owner}/items/{id}/raw", specs, values(.path, [("owner", "me"), ("id", 42)]))
        #expect(path == "/repos/me/items/42/raw")
    }

    @Test func percentEncodesReservedCharsInPathValues() throws {
        let specs = [ParamSpec("name", .path, .simple, explode: false)]
        #expect(try ParameterSerializer.path("/files/{name}", specs, values(.path, [("name", "a/b?c#d e")])) == "/files/a%2Fb%3Fc%23d%20e")
        #expect(try ParameterSerializer.path("/files/{name}", specs, values(.path, [("name", "日本")])) == "/files/%E6%97%A5%E6%9C%AC")
        #expect(try ParameterSerializer.path("/files/{name}", specs, values(.path, [("name", "%41|[")])) == "/files/%2541%7C%5B")
    }

    @Test func doesNotReExpandPlaceholdersInValues() throws {
        let specs = [ParamSpec("a", .path, .simple, explode: false), ParamSpec("b", .path, .simple, explode: false)]
        #expect(try ParameterSerializer.path("/{a}/{b}", specs, values(.path, [("a", "{b}"), ("b", "x")])) == "/%7Bb%7D/x")
    }

    @Test func rejectsMissingAndDotSegmentValues() throws {
        let specs = [ParamSpec("id", .path, .simple, explode: false)]
        #expect(throws: ArgumentError.self) { try ParameterSerializer.path("/x/{id}", specs, RequestValues()) }
        #expect(throws: ArgumentError.self) { try ParameterSerializer.path("/x/{id}", specs, values(.path, [("id", "..")])) }
        #expect(throws: ArgumentError.self) { try ParameterSerializer.path("/x/{id}", specs, values(.path, [("id", "")])) }
        #expect(try ParameterSerializer.path("/x/{id}", specs, values(.path, [("id", "...")])) == "/x/...")
    }

    @Test func emitsPrefixOnlyForEmptyCompositesAndMatrixEmptyString() throws {
        func run(_ style: ParamStyle, _ explode: Bool, _ value: JSONValue) throws -> String {
            try ParameterSerializer.path("p{color}", [ParamSpec("color", .path, style, explode: explode)], values(.path, [("color", value)]))
        }
        #expect(try run(.label, false, []) == "p.")
        #expect(try run(.matrix, true, [:]) == "p;color")
        #expect(try run(.simple, false, []) == "p")
        #expect(try run(.matrix, false, "") == "p;color")
    }

    @Test func serializesDatesAsIsoStrings() throws {
        let specs = [ParamSpec("at", .path, .simple, explode: false)]
        var values = RequestValues()
        try values.path("at", Date(timeIntervalSince1970: 1_704_164_645))
        #expect(try ParameterSerializer.path("/{at}", specs, values) == "/2024-01-02T03%3A04%3A05.000Z")
    }

    @Test func allowReservedKeepsQueryReservedChars() throws {
        let specs = [ParamSpec("reserved", .query, .form, explode: true, allowReserved: true)]
        #expect(ParameterSerializer.query(specs, try values(.query, [("reserved", "a/b?c:d")])) == "reserved=a/b?c:d")
        // `#`, `[` and `]` are not allowed in a URL query, so they stay encoded.
        #expect(ParameterSerializer.query(specs, try values(.query, [("reserved", "#[]")])) == "reserved=%23%5B%5D")
    }

    @Test func keepsEncodeUriComponentSafeChars() throws {
        let specs = [ParamSpec("q", .query, .form, explode: true)]
        #expect(ParameterSerializer.query(specs, try values(.query, [("q", "!'()*~-_.")])) == "q=!'()*~-_.")
    }

    @Test func skipsNilAndNullValuesAndKeepsSpecOrder() throws {
        let specs = [
            ParamSpec("limit", .query, .form, explode: true),
            ParamSpec("trace", .header, .simple, explode: false),
            ParamSpec("tags", .query, .form, explode: true),
            ParamSpec("gone", .query, .form, explode: true),
        ]
        var values = RequestValues()
        try values.query("tags", ["a", nil, "b"] as [String?])
        try values.query("limit", 10)
        try values.query("gone", nil as String?)
        try values.header("trace", "z")
        #expect(ParameterSerializer.query(specs, values) == "limit=10&tags=a&tags=b")
        #expect(ParameterSerializer.query([], RequestValues()) == "")
    }

    @Test func serializesEnumsByRawValueAndNumbersLikeJavaScript() throws {
        enum Color: String, Encodable { case red }
        let specs = [ParamSpec("c", .query, .form, explode: true), ParamSpec("n", .query, .form, explode: false)]
        var values = RequestValues()
        try values.query("c", Color.red)
        try values.query("n", [1.0, 0.5, 1e21])
        #expect(ParameterSerializer.query(specs, values) == "c=red&n=1,0.5,1e%2B21")
    }

    @Test func serializesHeadersWithoutEncodingAndRejectsCrLf() throws {
        let spec = ParamSpec("X-Ids", .header, .simple, explode: false)
        #expect(try ParameterSerializer.header(spec, ["a b", "c"]) == "a b,c")
        #expect(try ParameterSerializer.header(ParamSpec("X", .header, .simple, explode: true), ["k": "v", "n": 1]) == "k=v,n=1")
        #expect(try ParameterSerializer.header(spec, .null) == nil)
        #expect(throws: ArgumentError.self) { try ParameterSerializer.header(spec, "a\r\nb") }
    }

    @Test func joinsCookiesWithSemicolonSpace() throws {
        let specs = [ParamSpec("theme", .cookie, .form, explode: true), ParamSpec("tags", .cookie, .form, explode: false)]
        #expect(ParameterSerializer.cookie(specs, try values(.cookie, [("theme", "dark mode"), ("tags", ["x", "y"])])) == "theme=dark%20mode; tags=x,y")
        #expect(ParameterSerializer.cookie(specs, RequestValues()) == nil)
    }

    @Test func formEncodingMatchesUrlSearchParams() {
        #expect(PercentEncoding.form("a b&c") == "a+b%26c")
        #expect(PercentEncoding.form("*-._~!") == "*-._%7E%21")
    }
}
