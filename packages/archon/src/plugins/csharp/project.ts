import type { PluginContext } from '../../plugin/types.js';
import { escapeXml } from './emit.js';
import type { CSharpPluginOptions } from './index.js';

const VERSION = /^\d+(\.\d+){1,3}(-[0-9A-Za-z.-]+)?$/;

/** The project file name and content, or `undefined` when `package` is `false`. */
export function renderProject(ctx: PluginContext<CSharpPluginOptions>, namespace: string): { file: string; content: string } | undefined {
  const pkg = ctx.options.package;
  if (pkg === false) return undefined;
  const name = pkg?.name ?? namespace;
  let version = pkg?.version ?? ctx.ir.info.version;
  const parts = version.split('-')[0]?.split('.').map(Number) ?? [];
  if (!VERSION.test(version) || parts.some((p) => p > 65534)) {
    ctx.diagnostics.warn('csharp-invalid-version', `"${version}" is not a valid .NET package version; using 1.0.0 (set csharp({ package: { version } })).`);
    version = '1.0.0';
  }
  const description = pkg?.description ?? ctx.ir.info.description;
  const lines = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net10.0</TargetFramework>',
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>disable</ImplicitUsings>',
    '    <LangVersion>latest</LangVersion>',
    '    <IsAotCompatible>true</IsAotCompatible>',
    `    <RootNamespace>${escapeXml(namespace)}</RootNamespace>`,
    `    <AssemblyName>${escapeXml(name)}</AssemblyName>`,
    `    <PackageId>${escapeXml(name)}</PackageId>`,
    `    <Version>${escapeXml(version)}</Version>`,
    ...(description ? [`    <Description>${escapeXml(description)}</Description>`] : []),
    ...(pkg?.authors ? [`    <Authors>${escapeXml(pkg.authors)}</Authors>`] : []),
    ...(pkg?.license ? [`    <PackageLicenseExpression>${escapeXml(pkg.license)}</PackageLicenseExpression>`] : []),
    '    <GenerateDocumentationFile>true</GenerateDocumentationFile>',
    '    <NoWarn>$(NoWarn);CS1573;CS1591</NoWarn>',
    '  </PropertyGroup>',
    '</Project>',
  ];
  return { file: `${name}.csproj`, content: `${lines.join('\n')}\n` };
}
