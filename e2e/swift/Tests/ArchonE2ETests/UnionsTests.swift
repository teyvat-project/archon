import ArchonEdgeCases
import Testing

extension E2E {
    @Suite struct Unions {
        let client = Env.client()

        private func describe(_ shape: Shape) -> String {
            switch shape {
            case .circle(let circle): "circle r=\(circle.radius)"
            case .square(let square): "square s=\(square.side)"
            case .unknown(let raw): "unknown \(raw["kind"]?.stringValue ?? "-") side=\(raw["side"]?.intValue ?? -1)"
            }
        }

        @Test func narrowsADiscriminatedUnionAndKeepsAnUnknownVariantAsRawJson() async throws {
            let shapes = try await client.unions.listShapes()
            #expect(shapes.map(describe) == ["circle r=1.0", "square s=2.0", "unknown hexagon side=3"])
            #expect(shapes[0] == .circle(Circle(radius: 1)))
        }

        @Test func receivesAnUntaggedUnionByTryingVariantsInOrder() async throws {
            let pets = try await client.unions.listPets()
            #expect(pets == [.cat(Cat(name: "Tama", meows: true)), .dog(Dog(name: "Pochi", barks: true))])
        }

        @Test func receivesKnownAndUnknownEnumValuesWithoutFailing() async throws {
            let values = try await client.unions.getEnumValues()
            #expect(values.status == .active)
            #expect(values.priority == ._2)
            #expect(values.statuses[0] == .pending)
            #expect(!values.statuses[1].isKnown)
            #expect(values.statuses[1].rawValue == "archived")
            #expect(values.color == nil)
            #expect(values.level?.isKnown == false)
            #expect(values.level?.rawValue == "unknown-level")
        }

        @Test func revivesDateTimeAndDateValuesIncludingNestedArrays() async throws {
            let dates = try await client.unions.getDates()
            #expect(dates.createdAt.iso == "2026-10-25T12:34:56.789Z")
            #expect(dates.birthday == CalendarDate(year: 2000, month: 1, day: 2))
            #expect(dates.updatedAt == nil)
            #expect(dates.timestamps?.map(\.iso) == ["2026-10-25T00:00:00.000Z", "2026-10-26T00:00:00.000Z"])
            let entry = try #require(dates.history.first)
            #expect(entry.at.iso == "2026-10-25T00:00:00.000Z")
            #expect(entry.days.flatMap { $0 }.count == 3)
            #expect(entry.days[1][0] == CalendarDate(year: 2026, month: 10, day: 3))
            #expect(dates.byKey?["first"]?.iso == "2026-01-01T00:00:00.000Z")
        }
    }
}
