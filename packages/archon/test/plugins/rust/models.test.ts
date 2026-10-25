import { describe, expect, it } from 'vitest';
import { arr, bin, bool, date, dateTime, doc, enumOf, generate, int, model, nullable, num, obj, prop, ref, squash, str, union } from './helpers.js';

const shapes = () =>
  doc({
    Shape: union([ref('Circle'), ref('Square')], { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } }),
    Circle: obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('radius', num, true)]),
    Square: obj([prop('kind', enumOf(['square']), true), prop('side', num, true)]),
  });

describe('rust plugin: models', () => {
  it('renders required, optional and nullable fields with serde attributes', async () => {
    const { files } = await generate(
      doc({
        Pet: obj(
          [prop('name', str, true), prop('note', str), prop('count', int), prop('parentId', nullable(str), true), prop('born', date), prop('type', str)],
          { description: 'A pet.' },
        ),
      }),
    );
    const pet = model(files, 'pet');
    expect(pet.startsWith('// Generated header\n')).toBe(true);
    expect(squash(pet)).toContain(
      squash(`/// A pet.
        #[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
        pub struct Pet {
            pub name: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub note: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub count: Option<i64>,
            #[serde(rename = "parentId")]
            pub parent_id: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub born: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub r#type: Option<String>,
        }`),
    );
    expect(files.get('src/models/mod.rs')).toContain('mod pet;\n\npub use self::pet::Pet;\n');
  });

  it('maps formats and nullability', async () => {
    const { files } = await generate(
      doc({
        Types: obj([
          prop('at', dateTime, true),
          prop('i32', { kind: 'integer', format: 'int32', nullable: false }, true),
          prop('i64', { kind: 'integer', format: 'int64', nullable: false }, true),
          prop('f32', { kind: 'number', format: 'float', nullable: false }, true),
          prop('f64', num, true),
          prop('file', bin, true),
          prop('any', { kind: 'unknown', nullable: false }, true),
          prop('list', arr(nullable(str)), true),
          prop('map', obj([], { additionalProperties: int }), true),
          prop('flag', bool, true),
        ]),
      }),
    );
    const types = squash(model(files, 'types'));
    for (const field of [
      'pub at: String,',
      'pub i32: i32,',
      'pub i64: i64,',
      'pub f32: f32,',
      'pub f64: f64,',
      'pub file: crate::core::ApiFile,',
      'pub any: serde_json::Value,',
      'pub list: Vec<Option<String>>,',
      'pub map: std::collections::HashMap<String, i64>,',
      'pub flag: bool,',
    ]) {
      expect(types).toContain(field);
    }
  });

  it('applies typeMappings and typeOverride, and then does not derive Default', async () => {
    const ir = doc({ Event: obj([prop('at', dateTime, true), prop('id', { kind: 'string', format: 'uuid', nullable: false }, true), prop('n', int)]) });
    const { files } = await generate(ir, {
      typeMappings: { 'string:date-time': 'chrono::DateTime<chrono::Utc>', integer: 'u32' },
      hooks: { typeOverride: (s) => (s.kind === 'string' && s.format === 'uuid' ? 'uuid::Uuid' : undefined) },
    });
    const event = model(files, 'event');
    expect(event).toContain('pub at: chrono::DateTime<chrono::Utc>,');
    expect(event).toContain('pub id: uuid::Uuid,');
    expect(event).toContain('pub n: Option<u32>,');
    expect(event).toContain('#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]');
  });

  it('expands non-object named schemas and falls back to Value on alias cycles', async () => {
    const { files } = await generate(
      doc({ Id: str, Ids: arr(ref('Id')), A: ref('B'), B: ref('A'), Holder: obj([prop('ids', ref('Ids'), true), prop('a', ref('A'), true)]) }),
    );
    const holder = model(files, 'holder');
    expect(holder).toContain('pub ids: Vec<String>,');
    expect(holder).toContain('pub a: serde_json::Value,');
    expect([...files.keys()].filter((f) => f.startsWith('src/models/'))).toEqual(['src/models/holder.rs', 'src/models/mod.rs']);
  });

  it('refers to other models through super and boxes direct cycles only', async () => {
    const { files } = await generate(
      doc({
        Node: obj([prop('id', str, true), prop('children', arr(ref('Node')), true), prop('parent', ref('Node')), prop('next', ref('Node'), true)]),
        A: obj([prop('b', ref('B'), true)]),
        B: obj([prop('a', ref('A'))]),
        Leaf: obj([prop('node', ref('Node'))]),
      }),
    );
    const node = model(files, 'node');
    expect(node).toContain('pub children: Vec<super::Node>,');
    expect(node).toContain('pub parent: Option<Box<super::Node>>,');
    expect(node).toContain('pub next: Box<super::Node>,');
    expect(node).not.toContain('Default');
    expect(model(files, 'a')).toContain('pub b: Box<super::B>,');
    expect(model(files, 'b')).toContain('pub a: Option<Box<super::A>>,');
    expect(model(files, 'leaf')).toContain('pub node: Option<super::Node>,');
  });

  it('renders extensible enums with an Unknown variant', async () => {
    const { files } = await generate(
      doc({ Status: enumOf(['active', 'in-active', 'unknown', '', '1st']), Priority: enumOf([1, 2, -1], 'integer'), Ratio: enumOf([0.5, 2], 'number') }),
    );
    const status = squash(model(files, 'status'));
    expect(status).toContain(squash('pub enum Status { Active, InActive, Unknown2, Empty, Value1st, /// A value the API did not declare. Unknown(String), }'));
    expect(status).toContain(squash("pub const KNOWN_VALUES: &'static [Status] = &[Status::Active, Status::InActive, Status::Unknown2, Status::Empty, Status::Value1st];"));
    expect(status).toContain(squash('Self::InActive => "in-active",'));
    expect(status).toContain(squash('"in-active" => Self::InActive,'));
    expect(status).toContain(squash('_ => Self::Unknown(value.to_owned()),'));
    expect(status).toContain('impl std::hash::Hash for Status');
    expect(status).toContain(squash('serializer.serialize_str(self.as_str())'));

    const priority = squash(model(files, 'priority'));
    expect(priority).toContain(squash('pub enum Priority { Value1, Value2, Minus1, /// A value the API did not declare. Unknown(i64), }'));
    expect(priority).toContain(squash('pub fn value(&self) -> i64 {'));
    expect(priority).toContain(squash('-1 => Self::Minus1,'));
    expect(priority).toContain(squash('serializer.serialize_i64(self.value())'));

    const ratio = squash(model(files, 'ratio'));
    expect(ratio).toContain('#[derive(Debug, Clone, Copy)]');
    expect(ratio).toContain(squash('if value == 0.5 { Self::Value05 } else if value == 2.0 { Self::Value2 } else { Self::Unknown(value) }'));
    expect(ratio).not.toContain('impl Eq');
  });

  it('renders a discriminated union reading the tag and keeping unknown tags as raw JSON', async () => {
    const { files } = await generate(shapes());
    const shape = squash(model(files, 'shape'));
    expect(shape).toContain(squash('pub enum Shape { Circle(super::Circle), Square(super::Square), /// A value no variant matched, kept as raw JSON. Unknown(serde_json::Value), }'));
    expect(shape).toContain(squash('impl From<super::Circle> for Shape { fn from(value: super::Circle) -> Self { Self::Circle(value) } }'));
    expect(shape).toContain(squash('let tag = value.get("kind").and_then(serde_json::Value::as_str).map(str::to_owned);'));
    expect(shape).toContain(squash('Some("circle") => serde_json::from_value(value).map(Self::Circle).map_err(serde::de::Error::custom),'));
    expect(shape).toContain(squash('_ => Ok(Self::Unknown(value)),'));
    expect(shape).toContain(squash('Self::Square(value) => serde::Serialize::serialize(value, serializer),'));
    // The variants keep their discriminator field.
    expect(model(files, 'circle')).toContain('pub kind: String,');
    expect(model(files, 'square')).toContain('pub kind: super::SquareKind,');
  });

  it('renders an untagged union with wrappers for non-model variants', async () => {
    const { files } = await generate(
      doc({
        Mixed: union([ref('Cat'), str, int, arr(ref('Cat')), obj([], { additionalProperties: str }), { kind: 'null', nullable: true }]),
        Cat: obj([prop('meows', bool, true)]),
      }),
    );
    const mixed = squash(model(files, 'mixed'));
    expect(mixed).toContain(squash('#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)] #[serde(untagged)] pub enum Mixed {'));
    expect(mixed).toContain(
      squash('Cat(super::Cat), String(String), Integer(i64), CatList(Vec<super::Cat>), StringMap(std::collections::HashMap<String, String>), /// A value no variant matched, kept as raw JSON. Unknown(serde_json::Value),'),
    );
    expect(mixed).not.toContain('impl serde::Deserialize');
  });

  it('flattens cyclic untagged unions and boxes unions holding themselves', async () => {
    const { files } = await generate(
      doc({
        U1: union([ref('U2'), str]),
        U2: union([ref('U1'), int]),
        Tree: union([ref('Branch'), str]),
        Branch: obj([prop('left', ref('Tree'), true)]),
      }),
    );
    expect(squash(model(files, 'u1'))).toContain(squash('pub enum U1 { Integer(i64), String(String),'));
    expect(squash(model(files, 'u2'))).toContain(squash('pub enum U2 { String(String), Integer(i64),'));
    expect(model(files, 'tree')).toContain('Branch(Box<super::Branch>),');
    expect(model(files, 'tree')).toContain('Self::Branch(Box::new(value))');
    expect(model(files, 'branch')).toContain('pub left: Box<super::Tree>,');
  });

  it('names a variant holding a model called Unknown apart from the fallback', async () => {
    const { files } = await generate(doc({ U: union([ref('Unknown'), str]), Unknown: obj([prop('a', str)]) }));
    expect(squash(model(files, 'u'))).toContain(squash('Unknown2(super::Unknown), String(String), /// A value no variant matched, kept as raw JSON. Unknown(serde_json::Value),'));
  });

  it('marks deprecated schemas and fields', async () => {
    const { files } = await generate(doc({ Old: obj([prop('a', { ...str, deprecated: true })], { deprecated: true }) }));
    expect(squash(model(files, 'old'))).toContain(squash('#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)] #[deprecated] pub struct Old { #[deprecated]'));
  });
});
