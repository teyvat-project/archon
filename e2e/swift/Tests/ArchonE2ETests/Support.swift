import ArchonEdgeCases
import Foundation
import Testing

/// Every test talks to the same mock server, whose counters (`/__stats`) are compared before and after, so the whole
/// suite runs serially.
@Suite(.serialized) struct E2E {}

enum Env {
    static var baseUrl: String { variable("ARCHON_E2E_BASE_URL") }

    static var secondaryUrl: String { variable("ARCHON_E2E_SECONDARY_URL") }

    static func client(auth: ApiAuth? = nil, headers: ApiHeaders = [:], middleware: [any Middleware] = []) -> ApiClient {
        ApiClient(baseUrl: baseUrl, auth: auth, headers: headers, middleware: middleware)
    }

    /// The mock server's counters: tokens issued and requests per raw path.
    static func stats() async throws -> (tokensIssued: Int, requests: [String: Int]) {
        let response = try await URLSessionTransport.shared.send(ApiRequest(method: .get, url: try ApiURL.make("\(baseUrl)/__stats")))
        let json = try ApiJSON.decode(JSONValue.self, from: response.body)
        var requests: [String: Int] = [:]
        for (path, count) in json["requests"]?.objectValue ?? [:] { requests[path] = Int(count.intValue ?? 0) }
        return (Int(json["tokensIssued"]?.intValue ?? 0), requests)
    }

    static func requestCount(_ path: String) async throws -> Int {
        try await stats().requests[path] ?? 0
    }

    private static func variable(_ name: String) -> String {
        guard let value = ProcessInfo.processInfo.environment[name] else {
            fatalError("\(name) is not set; run the suite with `pnpm test:e2e:swift`.")
        }
        return value
    }
}

/// A thread-safe list for recording from `@Sendable` closures.
final class Recorder<Element: Sendable>: @unchecked Sendable {
    private var items: [Element] = []
    private let lock = NSLock()

    func append(_ element: Element) {
        lock.lock()
        defer { lock.unlock() }
        items.append(element)
    }

    var all: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

/// A value shared with `@Sendable` closures.
final class Box<Value: Sendable>: @unchecked Sendable {
    private var stored: Value
    private let lock = NSLock()

    init(_ value: Value) { stored = value }

    var value: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            stored = newValue
        }
    }
}

extension Date {
    var iso: String { RFC3339.format(self) }
}
