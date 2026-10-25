mod support;

use archon_edge_cases::models::{Pet, Priority, Shape, Status};
use support::client;

fn describe(shape: &Shape) -> String {
    match shape {
        Shape::Circle(c) => format!("circle r={}", c.radius),
        Shape::Square(s) => format!("square s={}", s.side),
        Shape::Unknown(raw) => format!("unknown side={}", raw["side"]),
    }
}

#[tokio::test]
async fn narrows_a_discriminated_union_and_keeps_an_unknown_variant_as_raw_json() {
    let shapes = client().unions().list_shapes().await.unwrap().data;
    assert_eq!(shapes.iter().map(describe).collect::<Vec<_>>(), ["circle r=1", "square s=2", "unknown side=3"]);
    let Shape::Circle(circle) = &shapes[0] else { panic!("{shapes:?}") };
    assert_eq!((circle.kind.as_str(), circle.radius), ("circle", 1.0));
    let Shape::Square(square) = &shapes[1] else { panic!("{shapes:?}") };
    assert_eq!((square.kind.as_str(), square.side), ("square", 2.0));
    let Shape::Unknown(raw) = &shapes[2] else { panic!("{shapes:?}") };
    assert_eq!(raw["kind"], "hexagon");
    // An unknown variant is written back as it was read.
    assert_eq!(serde_json::to_value(&shapes[2]).unwrap(), serde_json::json!({ "kind": "hexagon", "side": 3 }));
}

#[tokio::test]
async fn receives_an_untagged_union_by_trying_variants_in_order() {
    let pets = client().unions().list_pets().await.unwrap().data;
    let Pet::Cat(cat) = &pets[0] else { panic!("{pets:?}") };
    assert_eq!((cat.name.as_str(), cat.meows), ("Tama", true));
    let Pet::Dog(dog) = &pets[1] else { panic!("{pets:?}") };
    assert_eq!((dog.name.as_str(), dog.barks), ("Pochi", true));
}

#[tokio::test]
async fn receives_known_and_unknown_enum_values_without_failing() {
    let values = client().unions().get_enum_values().await.unwrap().data;
    assert_eq!(values.status, Status::Active);
    assert_eq!(values.priority, Priority::Value2);
    assert_eq!(values.statuses[0], Status::Pending);
    assert!(!values.statuses[1].is_known());
    assert_eq!(values.statuses[1].as_str(), "archived");
    assert_eq!(values.color, None);
    let level = values.level.unwrap();
    assert!(!level.is_known());
    assert_eq!(level.as_str(), "unknown-level");
}

#[tokio::test]
async fn keeps_date_time_and_date_values_as_their_strings_including_nested_arrays() {
    let dates = client().unions().get_dates().await.unwrap().data;
    assert_eq!(dates.created_at, "2026-10-25T12:34:56.789Z");
    assert_eq!(dates.birthday, "2000-01-02");
    assert_eq!(dates.updated_at, None);
    assert_eq!(dates.timestamps.unwrap(), ["2026-10-25T09:00:00+09:00", "2026-10-26T00:00:00Z"]);
    let entry = &dates.history[0];
    assert_eq!(entry.at, "2026-10-25T00:00:00Z");
    assert_eq!(entry.days.iter().flatten().count(), 3);
    assert_eq!(entry.days[1][0], "2026-10-03");
    assert_eq!(dates.by_key.unwrap()["first"], "2026-01-01T00:00:00Z");
}
