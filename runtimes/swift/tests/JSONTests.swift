import Foundation
import Testing

@testable import ArchonRuntime

private struct Ordered: Codable, Equatable {
    var zeta: Int
    var alpha: String
    var mid: [Double]
    var at: Date
    var nested: Inner?

    struct Inner: Codable, Equatable {
        var b: Bool
        var a: String?
    }
}

@Suite struct JSONTests {
    @Test func encodesKeysInDeclarationOrderWithoutEscapingSlashes() throws {
        let value = Ordered(zeta: 1, alpha: "a/b \"q\" \n", mid: [1, 0.1, -2.5], at: Date(timeIntervalSince1970: 0.5), nested: .init(b: true, a: nil))
        #expect(try ApiJSON.encode(value).text == #"{"zeta":1,"alpha":"a/b \"q\" \n","mid":[1,0.1,-2.5],"at":"1970-01-01T00:00:00.500Z","nested":{"b":true}}"#)
    }

    @Test func roundTripsThroughJSONDecoder() throws {
        let value = Ordered(zeta: 7, alpha: "日本", mid: [], at: Date(timeIntervalSince1970: 1_792_931_696.789), nested: nil)
        let decoded = try ApiJSON.decode(Ordered.self, from: ApiJSON.encode(value))
        #expect(decoded == value)
    }

    @Test func formatsNumbersLikeJavaScript() {
        let cases: [(Double, String)] = [
            (0, "0"), (1, "1"), (-1, "-1"), (0.1, "0.1"), (1.5, "1.5"), (100, "100"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
            (1e-7, "1e-7"), (0.000001, "0.000001"), (123.456, "123.456"), (1.5e300, "1.5e+300"), (5e-324, "5e-324"), (-0.0001, "-0.0001"),
            (.infinity, "null"),
        ]
        for (value, expected) in cases { #expect(ApiJSON.formatNumber(value) == expected, "\(value)") }
    }

    @Test func escapesControlCharacters() {
        #expect(ApiJSON.serialize("\u{01}\t\u{1F}") == #""\u0001\t\u001f""#)
    }

    @Test func decodesAnyJSONIntoJSONValue() throws {
        let value = try ApiJSON.decode(JSONValue.self, from: Data(#"{"a":[1,2.5,"x",true,null,{"b":{}}]}"#.utf8))
        #expect(value["a"]?[0] == .int(1))
        #expect(value["a"]?[1] == .double(2.5))
        #expect(value["a"]?[2] == "x")
        #expect(value["a"]?[3] == true)
        #expect(value["a"]?[4] == .null)
        #expect(value["a"]?[5]?["b"] == .object([:]))
    }

    @Test func jsonObjectKeepsInsertionOrderAndIgnoresItForEquality() {
        var object: JSONObject = ["b": 1, "a": 2]
        object["c"] = 3
        object["b"] = 4
        #expect(object.keys == ["b", "a", "c"])
        object["a"] = nil
        #expect(object.keys == ["b", "c"])
        #expect(JSONObject([("x", 1), ("y", 2)] as [(String, JSONValue)]) == ["y": 2, "x": 1])
    }

    @Test func parsesRfc3339WithOffsetsAndFractions() throws {
        // Date keeps seconds since 2001, so compare at millisecond precision.
        let parsed = try #require(RFC3339.parse("2026-10-25T12:34:56.789Z"))
        #expect(abs(parsed.timeIntervalSince1970 - 1_792_931_696.789) < 0.000_01)
        #expect(RFC3339.format(parsed) == "2026-10-25T12:34:56.789Z")
        #expect(RFC3339.parse("2026-10-25T09:00:00+09:00") == RFC3339.parse("2026-10-25T00:00:00Z"))
        #expect(RFC3339.parse("1969-12-31T23:59:59Z")?.timeIntervalSince1970 == -1)
        #expect(RFC3339.parse("2026-02-30T00:00:00Z") == nil)
        #expect(RFC3339.parse("2026-10-25") == nil)
        #expect(RFC3339.format(Date(timeIntervalSince1970: -1.5)) == "1969-12-31T23:59:58.500Z")
        #expect(RFC3339.format(try #require(RFC3339.parse("2000-02-29T23:59:59.999+00:00"))) == "2000-02-29T23:59:59.999Z")
    }

    @Test func calendarDateCodesAsYyyyMmDd() throws {
        let date = try #require(CalendarDate("2000-01-02"))
        #expect(date == CalendarDate(year: 2000, month: 1, day: 2))
        #expect(try ApiJSON.encode([date]).text == #"["2000-01-02"]"#)
        #expect(try ApiJSON.decode([CalendarDate].self, from: Data(#"["2026-10-03"]"#.utf8)) == [CalendarDate(year: 2026, month: 10, day: 3)])
        #expect(CalendarDate("2026-13-01") == nil)
        #expect(CalendarDate("2026-1-01") == nil)
        #expect(CalendarDate(year: 2026, month: 1, day: 1) < CalendarDate(year: 2026, month: 1, day: 2))
    }

    @Test func apiFileIsBase64InJson() throws {
        #expect(try ApiJSON.encode(ApiFile(Data("hi".utf8), fileName: "a.txt")).text == #""aGk=""#)
        #expect(try ApiJSON.decode(ApiFile.self, from: Data(#""aGk=""#.utf8)).data == Data("hi".utf8))
    }

    @Test func headersAreCaseInsensitiveAndOrdered() {
        var headers: ApiHeaders = ["Accept": "a", "X-One": "1"]
        headers["accept"] = "b"
        headers.set("X-Two", "2")
        #expect(headers["ACCEPT"] == "b")
        #expect(headers.map(\.name) == ["accept", "X-One", "X-Two"])
        headers.remove("x-one")
        #expect(!headers.contains("X-One"))
        #expect(headers.count == 2)
    }
}
