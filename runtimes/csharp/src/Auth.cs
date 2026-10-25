using System.Threading;
using System.Threading.Tasks;

namespace Archon.Runtime;

/// <summary>Applies authentication innermost in the chain.</summary>
internal sealed class AuthMiddleware : IApiMiddleware
{
    private readonly ApiClientCore _core;

    public AuthMiddleware(ApiClientCore core)
    {
        _core = core;
    }

    public async Task<ApiResponse> InvokeAsync(ApiRequest request, ApiNext next, CallContext context, CancellationToken cancellationToken)
    {
        if (_core.Options.CustomAuth is { } custom) await custom(request, context, cancellationToken).ConfigureAwait(false);
        return await next(request, cancellationToken).ConfigureAwait(false);
    }
}
