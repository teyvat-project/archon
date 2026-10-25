package e2e

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"archon.e2e/edgecases"
)

func describeShape(shape edgecases.Shape) string {
	switch {
	case shape.Circle != nil:
		return fmt.Sprintf("circle r=%v", shape.Circle.Radius)
	case shape.Square != nil:
		return fmt.Sprintf("square s=%v", shape.Square.Side)
	}
	var raw struct {
		Side int `json:"side"`
	}
	_ = json.Unmarshal(shape.Raw, &raw)
	return fmt.Sprintf("unknown side=%d", raw.Side)
}

func TestNarrowsADiscriminatedUnionAndKeepsAnUnknownVariantAsRawJSON(t *testing.T) {
	shapes, _, err := newClient().Unions.ListShapes(ctx)
	noError(t, err)
	equal(t, len(shapes), 3)
	equal(t, describeShape(shapes[0])+"; "+describeShape(shapes[1])+"; "+describeShape(shapes[2]), "circle r=1; square s=2; unknown side=3")
	equal(t, *shapes[0].Circle, edgecases.Circle{Kind: "circle", Radius: 1})
	equal(t, *shapes[1].Square, edgecases.Square{Kind: edgecases.SquareKindSquare, Side: 2})
	var unknown struct {
		Kind string `json:"kind"`
	}
	noError(t, json.Unmarshal(shapes[2].Raw, &unknown))
	equal(t, unknown.Kind, "hexagon")

	// Written back as received; a variant built without its tag gets it.
	data, err := json.Marshal([]edgecases.Shape{shapes[2], {Circle: &edgecases.Circle{Radius: 5}}})
	noError(t, err)
	equal(t, string(data), `[{"kind":"hexagon","side":3},{"kind":"circle","radius":5}]`)
}

func TestReceivesAnUntaggedUnionByTryingVariantsInOrder(t *testing.T) {
	pets, _, err := newClient().Unions.ListPets(ctx)
	noError(t, err)
	equal(t, len(pets), 2)
	if pets[0].Cat == nil || pets[1].Dog == nil {
		t.Fatalf("got %+v", pets)
	}
	equal(t, pets[0].Cat.Name, "Tama")
	equal(t, pets[0].Cat.Meows, true)
	equal(t, pets[1].Dog.Name, "Pochi")
	equal(t, pets[1].Dog.Barks, true)
}

func TestReceivesKnownAndUnknownEnumValuesWithoutFailing(t *testing.T) {
	values, _, err := newClient().Unions.GetEnumValues(ctx)
	noError(t, err)
	equal(t, values.Status, edgecases.StatusActive)
	equal(t, values.Priority, edgecases.Priority2)
	equal(t, values.Statuses[0], edgecases.StatusPending)
	equal(t, values.Statuses[1].IsKnown(), false)
	equal(t, values.Statuses[1], "archived")
	if values.Color != nil {
		t.Errorf("color %v", *values.Color)
	}
	equal(t, values.Level.IsKnown(), false)
	equal(t, *values.Level, "unknown-level")
}

func TestReadsDateTimesAsTimeAndDatesAsDates(t *testing.T) {
	dates, _, err := newClient().Unions.GetDates(ctx)
	noError(t, err)
	equal(t, dates.CreatedAt.Equal(time.Date(2026, 10, 25, 12, 34, 56, 789_000_000, time.UTC)), true)
	equal(t, dates.Birthday.String(), "2000-01-02")
	if dates.UpdatedAt != nil {
		t.Errorf("updatedAt %v", dates.UpdatedAt)
	}
	equal(t, len(dates.Timestamps), 2)
	equal(t, dates.Timestamps[0].Equal(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)), true)
	_, offset := dates.Timestamps[0].Zone()
	equal(t, offset, 9*60*60)
	entry := dates.History[0]
	equal(t, entry.At.Equal(time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)), true)
	equal(t, len(entry.Days[0])+len(entry.Days[1]), 3)
	equal(t, entry.Days[1][0].String(), "2026-10-03")
	equal(t, dates.ByKey["first"].Equal(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), true)
}
