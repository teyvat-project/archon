namespace Archon.Runtime;

// Inside the namespace so these win over types of the generated SDK's root namespace (a model named Task, Type, ...).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

/// <summary>A bearer token or API key: a fixed string or a provider called on every send.</summary>
public sealed class TokenValue
{
    private readonly string? _token;
    private readonly Func<CancellationToken, ValueTask<string>>? _provider;

    public TokenValue(string token)
    {
        _token = token ?? throw new ArgumentNullException(nameof(token));
    }

    public TokenValue(Func<CancellationToken, ValueTask<string>> provider)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
    }

    public static implicit operator TokenValue(string token) => new(token);

    public ValueTask<string> GetAsync(CancellationToken cancellationToken) => _provider?.Invoke(cancellationToken) ?? ValueTask.FromResult(_token!);
}

public sealed record BasicCredentials(string Username, string Password);

/// <summary>HTTP Basic credentials: fixed or from a provider called on every send.</summary>
public sealed class BasicValue
{
    private readonly BasicCredentials? _credentials;
    private readonly Func<CancellationToken, ValueTask<BasicCredentials>>? _provider;

    public BasicValue(string username, string password)
    {
        _credentials = new BasicCredentials(username, password);
    }

    public BasicValue(Func<CancellationToken, ValueTask<BasicCredentials>> provider)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
    }

    public ValueTask<BasicCredentials> GetAsync(CancellationToken cancellationToken) => _provider?.Invoke(cancellationToken) ?? ValueTask.FromResult(_credentials!);
}

/// <summary>How the client authenticates at the token endpoint.</summary>
public enum OAuth2ClientAuth
{
    /// <summary><c>Authorization: Basic</c> (client_secret_basic).</summary>
    Basic,

    /// <summary><c>client_id</c> / <c>client_secret</c> in the form (client_secret_post).</summary>
    Post,
}

public sealed class OAuth2ClientCredentials
{
    public required string ClientId { get; init; }

    public required string ClientSecret { get; init; }

    /// <summary>Scopes requested in addition to those the operation needs.</summary>
    public IReadOnlyList<string>? Scopes { get; init; }

    /// <summary>Overrides the spec's token URL (relative URLs resolve against the base URL).</summary>
    public string? TokenUrl { get; init; }

    public OAuth2ClientAuth ClientAuth { get; init; } = OAuth2ClientAuth.Basic;
}

public sealed class OAuth2RefreshToken
{
    public required string RefreshToken { get; init; }

    public required string ClientId { get; init; }

    public string? ClientSecret { get; init; }

    public string? TokenUrl { get; init; }

    public OAuth2ClientAuth ClientAuth { get; init; } = OAuth2ClientAuth.Basic;

    /// <summary>Called after every token response that carries a (rotated) refresh token.</summary>
    public Func<TokenSet, CancellationToken, ValueTask>? OnRefreshed { get; init; }
}

/// <summary>OAuth2 / OpenID Connect credentials: a ready access token, or a grant the runtime runs and caches.</summary>
public sealed class OAuth2Value
{
    public TokenValue? AccessToken { get; init; }

    public OAuth2ClientCredentials? ClientCredentials { get; init; }

    public OAuth2RefreshToken? RefreshToken { get; init; }

    internal bool IsConfigured => AccessToken is not null || ClientCredentials is not null || RefreshToken is not null;
}

public sealed record TokenSet(string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt, string? Scope);

/// <summary>Which alternative of an operation's security requirements to apply.</summary>
public abstract record Selection
{
    private Selection()
    {
    }

    public sealed record Apply(SecurityRequirement Requirement) : Selection;

    public sealed record Anonymous : Selection;

    public sealed record Missing(IReadOnlyList<string> Schemes) : Selection;
}

public static class SecuritySelector
{
    /// <summary>
    /// Evaluates the OR-of-AND requirements in order and picks the first alternative whose schemes are all configured.
    /// An empty alternative (optional auth) is used only when no other one is satisfiable.
    /// </summary>
    public static Selection Select(IReadOnlyList<SecurityRequirement> requirements, Func<string, bool> isConfigured)
    {
        var optional = false;
        SecurityRequirement? firstNonEmpty = null;
        foreach (var requirement in requirements)
        {
            if (requirement.Schemes.Count == 0)
            {
                optional = true;
                continue;
            }
            firstNonEmpty ??= requirement;
            if (requirement.Schemes.All(s => isConfigured(s.Name))) return new Selection.Apply(requirement);
        }
        if (firstNonEmpty is null || optional) return new Selection.Anonymous();
        return new Selection.Missing(firstNonEmpty.Schemes.Where(s => !isConfigured(s.Name)).Select(s => s.Name).ToList());
    }
}

/// <summary>Applies authentication innermost in the chain (spec §8.2) and refreshes managed OAuth2 tokens once on 401.</summary>
internal sealed class AuthMiddleware : IApiMiddleware
{
    private readonly ApiClientCore _core;
    private readonly object _lock = new();
    private (IAuthConfig? Auth, string BaseUrl, HttpClientIdentity Http) _managersFor;
    private Dictionary<string, (OAuth2Value Value, OAuth2TokenManager Manager)> _managers = [];

    public AuthMiddleware(ApiClientCore core)
    {
        _core = core;
    }

    public async Task<ApiResponse> InvokeAsync(ApiRequest request, ApiNext next, CallContext context, CancellationToken cancellationToken)
    {
        // One snapshot per send: the options can change on another thread (a logout), and selecting the requirement,
        // applying it and re-applying it on 401 must all see the same credentials.
        var auth = new AuthSnapshot(_core.Options);
        var selection = SecuritySelector.Select(context.Security, scheme => IsConfigured(auth, scheme));
        if (selection is Selection.Missing missing)
        {
            throw new ApiAuthException($"Missing credentials for security scheme(s): {string.Join(", ", missing.Schemes)}.", missing.Schemes);
        }
        var requirement = selection is Selection.Apply apply ? apply.Requirement : null;

        var used = await ApplyAsync(auth, requirement, request, context, cancellationToken).ConfigureAwait(false);
        var response = await next(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode != 401 || used.Count == 0 || !request.Replayable) return response;

        response.Dispose();
        foreach (var (manager, token) in used) manager.Invalidate(token);
        await ApplyAsync(auth, requirement, request, context, cancellationToken).ConfigureAwait(false);
        return await next(request, cancellationToken).ConfigureAwait(false);
    }

    private bool IsConfigured(AuthSnapshot auth, string scheme)
    {
        // Schemes the generator cannot apply (http digest, mutualTLS, ...) are left out of the scheme table;
        // CustomAuth is responsible for them.
        if (!_core.SecuritySchemes.TryGetValue(scheme, out var spec)) return auth.CustomAuth is not null;
        return auth.Get(scheme) switch
        {
            null => false,
            OAuth2Value oauth => spec is SecuritySchemeSpec.OAuth2 or SecuritySchemeSpec.OpenIdConnect && oauth.IsConfigured,
            TokenValue => spec is SecuritySchemeSpec.HttpBearer or SecuritySchemeSpec.ApiKey,
            BasicValue => spec is SecuritySchemeSpec.HttpBasic,
            _ => false,
        };
    }

    /// <summary>Applies the requirement; returns each token manager used with the token it supplied.</summary>
    private async Task<List<(OAuth2TokenManager Manager, string Token)>> ApplyAsync(
        AuthSnapshot auth, SecurityRequirement? requirement, ApiRequest request, CallContext context, CancellationToken cancellationToken)
    {
        var used = new List<(OAuth2TokenManager, string)>();
        foreach (var scheme in requirement?.Schemes ?? [])
        {
            if (!_core.SecuritySchemes.TryGetValue(scheme.Name, out var spec)) continue; // left to CustomAuth
            var value = auth.Get(scheme.Name);
            switch (spec)
            {
                case SecuritySchemeSpec.HttpBearer:
                    request.Headers.Set("Authorization", $"Bearer {await ((TokenValue)value!).GetAsync(cancellationToken).ConfigureAwait(false)}");
                    break;
                case SecuritySchemeSpec.HttpBasic:
                    var basic = await ((BasicValue)value!).GetAsync(cancellationToken).ConfigureAwait(false);
                    request.Headers.Set("Authorization", $"Basic {Convert.ToBase64String(Encoding.UTF8.GetBytes($"{basic.Username}:{basic.Password}"))}");
                    break;
                case SecuritySchemeSpec.ApiKey key:
                    var apiKey = await ((TokenValue)value!).GetAsync(cancellationToken).ConfigureAwait(false);
                    switch (key.In)
                    {
                        case ApiKeyLocation.Header:
                            request.Headers.Set(key.Name, apiKey);
                            break;
                        case ApiKeyLocation.Query:
                            request.SetQueryParameter(key.Name, apiKey);
                            break;
                        default:
                            SetCookie(request.Headers, key.Name, PercentEncoding.Component(apiKey));
                            break;
                    }
                    break;
                case SecuritySchemeSpec.OAuth2 or SecuritySchemeSpec.OpenIdConnect:
                    var oauth = (OAuth2Value)value!;
                    string token;
                    if (oauth.AccessToken is not null)
                    {
                        token = await oauth.AccessToken.GetAsync(cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        var manager = ManagerFor(auth, scheme.Name, spec, oauth);
                        token = await manager.GetTokenAsync(scheme.Scopes, cancellationToken).ConfigureAwait(false);
                        used.Add((manager, token));
                    }
                    request.Headers.Set("Authorization", $"Bearer {token}");
                    break;
            }
        }
        if (auth.CustomAuth is { } custom) await custom(request, context, cancellationToken).ConfigureAwait(false);
        return used;
    }

    private OAuth2TokenManager ManagerFor(AuthSnapshot auth, string scheme, SecuritySchemeSpec spec, OAuth2Value value)
    {
        lock (_lock)
        {
            var http = _core.HttpClient;
            var key = (auth.Config, auth.BaseUrl, new HttpClientIdentity(http));
            if (!Equals(_managersFor, key))
            {
                _managers = [];
                _managersFor = key;
            }
            // A scheme's value can be replaced on the same IAuthConfig (settings are read on every request): a manager
            // serves only the value it was built from.
            if (_managers.TryGetValue(scheme, out var cached) && ReferenceEquals(cached.Value, value)) return cached.Manager;
            var specUrl = spec is SecuritySchemeSpec.OAuth2 o ? (value.RefreshToken is not null ? o.RefreshUrl ?? o.TokenUrl : o.TokenUrl) : null;
            Uri? baseUrl = Uri.TryCreate(auth.BaseUrl, UriKind.Absolute, out var parsed) ? parsed : null;
            var manager = new OAuth2TokenManager(http, value, specUrl, baseUrl, scheme, timeout: auth.Timeout);
            _managers[scheme] = (value, manager);
            return manager;
        }
    }

    private static void SetCookie(ApiHeaders headers, string name, string value)
    {
        var kept = (headers.Get("Cookie") ?? "").Split(';').Select(p => p.Trim()).Where(p => p != "" && p.Split('=', 2)[0] != name).ToList();
        kept.Add($"{name}={value}");
        headers.Set("Cookie", string.Join("; ", kept));
    }

    /// <summary>The auth settings of one send, read once; each scheme's value is resolved on first use and then kept.</summary>
    private sealed class AuthSnapshot(ClientOptions options)
    {
        private readonly Dictionary<string, object?> _values = [];

        public IAuthConfig? Config { get; } = options.AuthConfig;

        public Func<ApiRequest, CallContext, CancellationToken, ValueTask>? CustomAuth { get; } = options.CustomAuth;

        public string BaseUrl { get; } = options.BaseUrl;

        public TimeSpan? Timeout { get; } = options.Timeout;

        public object? Get(string scheme)
        {
            if (!_values.TryGetValue(scheme, out var value)) _values[scheme] = value = Config?.Get(scheme);
            return value;
        }
    }

    /// <summary>Compares HttpClients by reference.</summary>
    private readonly record struct HttpClientIdentity(System.Net.Http.HttpClient Client)
    {
        public bool Equals(HttpClientIdentity other) => ReferenceEquals(Client, other.Client);

        public override int GetHashCode() => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(Client);
    }
}
