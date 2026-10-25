import { describe, expect, it } from 'vitest';
import { escape, sanitize, swIdentifier } from '../../../src/plugins/swift/names.js';
import { arr, bin, bool, date, dateTime, doc, enumOf, generate, int, nullable, num, obj, prop, ref, source, squash, str, union } from './helpers.js';

const shapes = () =>
  doc({
    Shape: union([ref('Circle'), ref('Square')], { property: 'kind', mapping: { circle: 'Circle', square: 'Square' } }),
    Circle: obj([prop('kind', { kind: 'const', value: 'circle', nullable: false }, true), prop('radius', num, true)]),
    Square: obj([prop('kind', enumOf(['square']), true), prop('side', num, true)]),
  });

describe('swift plugin: names', () => {
  it('sanitizes identifiers and escapes keywords', () => {
    expect(swIdentifier('x-foo', 'camelCase')).toBe('xFoo');
    expect(swIdentifier('2fa', 'camelCase')).toBe('_2fa');
    expect(sanitize('')).toBe('_');
    expect(escape('class')).toBe('`class`');
    expect(escape('default')).toBe('`default`');
    expect(escape('type')).toBe('type');
  });

  it('avoids runtime, module, undeclarable and colliding type names', async () => {
    const { files, api } = await generate(
      doc({
        'Foo.Bar': obj([prop('a', str)]),
        '1Thing': obj([prop('a', str)]),
        'foo-bar': obj([prop('a', str)]),
        ApiRequest: obj([prop('a', str)]),
        Type: obj([prop('a', str)]),
        Foundation: obj([prop('a', str)]),
        TestApiCore: obj([prop('a', str)]),
        ApiAuth: obj([prop('a', str)]),
      }),
    );
    expect([...files.keys()].filter((f) => f.includes('/Models/')).map((f) => f.split('/').pop())).toEqual([
      'FooBar.swift',
      '_1Thing.swift',
      'FooBar2.swift',
      'ApiRequest2.swift',
      'Type2.swift',
      'Foundation2.swift',
      'TestApiCore2.swift',
      'ApiAuth2.swift',
    ]);
    expect(api.symbols.typeOf('ApiRequest')).toEqual({ name: 'ApiRequest2', module: 'TestApi', file: 'Sources/TestApi/Models/ApiRequest2.swift' });
  });

  it('names properties in camelCase and keeps wire names in CodingKeys', async () => {
    const { files } = await generate(
      doc({
        Thing: obj([prop('x-foo', str), prop('2fa', str), prop('class', str), prop('foo_bar', str), prop('fooBar', str), prop('self', str), prop('hashValue', int)]),
      }),
    );
    const thing = source(files, 'Models/Thing.swift');
    expect(thing).toContain('public var xFoo: String?');
    expect(thing).toContain('public var _2fa: String?');
    expect(thing).toContain('public var `class`: String?');
    expect(thing).toContain('public var fooBar: String?');
    expect(thing).toContain('public var fooBar2: String?');
    expect(thing).toContain('public var selfValue: String?');
    expect(thing).toContain('public var hashValueValue: Int?');
    expect(squash(thing)).toContain(
      squash(`case xFoo = "x-foo"
        case _2fa = "2fa"
        case \`class\`
        case fooBar = "foo_bar"
        case fooBar2 = "fooBar"
        case selfValue = "self"
        case hashValueValue = "hashValue"`),
    );
    expect(thing).toContain('self.`class` = try container.decodeIfPresent(String.self, forKey: .`class`)');
  });
});

describe('swift plugin: types', () => {
  it('maps formats and nullability', async () => {
    const { files } = await generate(
      doc({
        Kinds: obj([
          prop('at', dateTime, true),
          prop('day', date, true),
          prop('id', { kind: 'string', format: 'uuid', nullable: false }, true),
          prop('big', { kind: 'integer', format: 'int64', nullable: false }, true),
          prop('small', { kind: 'integer', format: 'int32', nullable: false }, true),
          prop('ratio', { kind: 'number', format: 'float', nullable: false }, true),
          prop('blob', { kind: 'string', format: 'byte', nullable: false }, true),
          prop('file', bin, true),
          prop('any', { kind: 'unknown', nullable: false }, true),
          prop('map', obj([], { additionalProperties: int }), true),
          prop('free', obj([]), true),
          prop('maybe', nullable(str), true),
          prop('later', bool),
        ]),
      }),
    );
    const kinds = source(files, 'Models/Kinds.swift');
    for (const line of [
      'public var at: Date',
      'public var day: CalendarDate',
      'public var id: UUID',
      'public var big: Int64',
      'public var small: Int32',
      'public var ratio: Float',
      'public var blob: Data',
      'public var file: ApiFile',
      'public var any: JSONValue',
      'public var map: [String: Int]',
      'public var free: [String: JSONValue]',
      'public var maybe: String?',
      'public var later: Bool?',
    ]) {
      expect(kinds).toContain(line);
    }
    // Required nullable: may be absent when decoding, written as null when encoding.
    expect(kinds).toContain('self.maybe = try container.decodeIfPresent(String.self, forKey: .maybe)');
    expect(kinds).toContain('try container.encode(maybe, forKey: .maybe)');
    expect(kinds).toContain('try container.encodeIfPresent(later, forKey: .later)');
  });

  it('expands non-object named schemas and falls back to JSONValue on alias cycles', async () => {
    const { files } = await generate(
      doc({ Tags: arr(str), Loop: ref('Loop2'), Loop2: ref('Loop'), Holder: obj([prop('tags', ref('Tags'), true), prop('loop', ref('Loop'), true)]) }),
    );
    const holder = source(files, 'Models/Holder.swift');
    expect(holder).toContain('public var tags: [String]');
    expect(holder).toContain('public var loop: JSONValue');
    expect([...files.keys()].some((f) => f.endsWith('/Tags.swift'))).toBe(false);
  });

  it('applies typeMappings and typeOverride', async () => {
    const { files } = await generate(doc({ T: obj([prop('at', dateTime, true), prop('n', int, true), prop('s', str, true)]) }), {
      typeMappings: { 'string:date-time': 'String', integer: 'Int64' },
      hooks: { typeOverride: (schema, { path }) => (schema.kind === 'string' && path.at(-1) === 's' ? 'Substring' : undefined) },
    });
    const t = source(files, 'Models/T.swift');
    expect(t).toContain('public var at: String');
    expect(t).toContain('public var n: Int64');
    expect(t).toContain('public var s: Substring');
  });

  it('qualifies standard types that a model shadows', async () => {
    const { files } = await generate(doc({ String: obj([prop('a', str, true)]), Date: obj([prop('at', dateTime, true)]), Error: obj([prop('code', int, true)]) }));
    const date = source(files, 'Models/Date.swift');
    expect(date).toContain('public struct Date: Codable, Hashable, Sendable');
    expect(date).toContain('public var at: Foundation.Date');
    expect(date).toContain('private enum CodingKeys: Swift.String, CodingKey');
    expect(source(files, 'Models/String.swift')).toContain('public var a: Swift.String');
    expect(source(files, 'Models/Error.swift')).toContain('public var code: Int');
  });
});

describe('swift plugin: models', () => {
  it('renders a struct with an init, CodingKeys and explicit coding', async () => {
    const { files } = await generate(doc({ Pet: obj([prop('name', str, true), prop('note', str), prop('parentId', nullable(str), true)], { description: 'A pet.' }) }));
    const pet = source(files, 'Models/Pet.swift');
    expect(pet.startsWith('// Generated header\n\nimport Foundation\nimport TestApiCore\n')).toBe(true);
    expect(pet).toContain('/// A pet.\npublic struct Pet: Codable, Hashable, Sendable {');
    expect(pet).toContain('public init(name: String, note: String? = nil, parentId: String?) {');
    expect(pet).toContain('self.name = try container.decode(String.self, forKey: .name)');
    expect(pet).toContain('try container.encodeIfPresent(note, forKey: .note)');
  });

  it('stores value cycles out of line and keeps arrays inline', async () => {
    const { files } = await generate(
      doc({
        Node: obj([prop('children', arr(ref('Node')), true), prop('parent', ref('Node'))]),
        A: obj([prop('b', ref('B'))]),
        B: obj([prop('a', ref('A')), prop('name', str)]),
      }),
    );
    const node = source(files, 'Models/Node.swift');
    expect(node).toContain('public var children: [Node]');
    expect(squash(node)).toContain(squash(`public var parent: Node? {
      get { _parent.value }
      set { _parent = Indirect(newValue) }
    }`));
    expect(node).toContain('private var _parent: Indirect<Node?>');
    expect(node).toContain('self._parent = Indirect(try container.decodeIfPresent(Node.self, forKey: .parent))');
    expect(source(files, 'Models/A.swift')).toContain('private var _b: Indirect<B?>');
    expect(source(files, 'Models/B.swift')).toContain('private var _a: Indirect<A?>');
    expect(source(files, 'Models/B.swift')).toContain('public var name: String?');
  });

  it('keeps additional properties of objects that also declare properties', async () => {
    const { files } = await generate(doc({ Bag: obj([prop('a', str)], { additionalProperties: str }) }));
    const bag = source(files, 'Models/Bag.swift');
    expect(bag).toContain('public var additionalProperties: [String: JSONValue]');
    expect(bag).toContain('for key in extra.allKeys where CodingKeys(rawValue: key.stringValue) == nil {');
    expect(bag).toContain('public init(a: String? = nil, additionalProperties: [String: JSONValue] = [:])');
  });

  it('renders enums with an unknown case', async () => {
    const { files } = await generate(doc({ Status: enumOf(['active', 'in-active', 'unknown', 'default', '']), Priority: enumOf([1, 2], 'integer') }));
    const status = source(files, 'Models/Status.swift');
    expect(status).toContain('public enum Status: Codable, Hashable, Sendable, RawRepresentable, CaseIterable {');
    expect(squash(status)).toContain(squash('case active case inActive case unknown2 case `default` case empty /// A value this version of the SDK does not know. case unknown(String)'));
    expect(status).toContain('case "in-active": self = .inActive');
    expect(status).toContain('case .unknown(let value): return value');
    expect(status).toContain('public static var allCases: [Status] { [.active, .inActive, .unknown2, .`default`, .empty] }');
    const priority = source(files, 'Models/Priority.swift');
    expect(priority).toContain('case _1');
    expect(priority).toContain('case unknown(Int)');
    expect(priority).toContain('case 2: self = ._2');
  });

  it('renders a discriminated union that keeps the tag on its variants', async () => {
    const { files } = await generate(shapes());
    const shape = source(files, 'Models/Shape.swift');
    expect(shape).toContain('public indirect enum Shape: Codable, Hashable, Sendable {');
    expect(squash(shape)).toContain(squash('case circle(Circle) case square(Square) /// A value that matched no variant, kept as raw JSON. case unknown(JSONValue)'));
    expect(shape).toContain('switch raw["kind"]?.stringValue {');
    expect(shape).toContain('case "circle": self = .circle(try decoder.singleValueContainer().decode(Circle.self))');
    expect(shape).toContain('default: self = .unknown(raw)');
    // The fixed tag is the default argument.
    expect(source(files, 'Models/Circle.swift')).toContain('public init(kind: String = "circle", radius: Double)');
    expect(source(files, 'Models/Square.swift')).toContain('public init(kind: SquareKind = .square, side: Double)');
  });

  it('renders an untagged union that tries variants in order', async () => {
    const { files } = await generate(
      doc({ Pet: union([ref('Cat'), ref('Dog'), str, arr(ref('Cat'))]), Cat: obj([prop('meows', bool, true)]), Dog: obj([prop('barks', bool, true)]) }),
    );
    const pet = source(files, 'Models/Pet.swift');
    expect(squash(pet)).toContain(squash('case cat(Cat) case dog(Dog) case string(String) case catList([Cat])'));
    expect(squash(pet)).toContain(squash(`if let value = try? decoder.singleValueContainer().decode(Cat.self) {
      self = .cat(value)
      return
    }`));
    expect(pet).toContain('self = .unknown(try JSONValue(from: decoder))');
    expect(pet).toContain('case .catList(let value): try container.encode(value)');
  });

  it('expands untagged unions that contain each other', async () => {
    const { files } = await generate(doc({ U1: union([ref('U2'), str]), U2: union([ref('U1'), int]) }));
    expect(squash(source(files, 'Models/U1.swift'))).toContain(squash('case int(Int) case string(String) /// A value that matched no variant, kept as raw JSON. case unknown(JSONValue)'));
  });

  it('notes deprecations in docs without attributes models would trip over', async () => {
    const { files } = await generate(doc({ Old: obj([prop('a', { ...str, deprecated: true, description: 'Gone.' })], { deprecated: true, description: 'Legacy.' }) }));
    const old = source(files, 'Models/Old.swift');
    expect(old).toContain('/// Legacy.\n///\n/// - Note: Deprecated.\npublic struct Old');
    expect(old).toContain('/// Gone.\n    /// - Note: Deprecated.\n    public var a: String?');
    expect(old).not.toContain('@available');
  });
});
