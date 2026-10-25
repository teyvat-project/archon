package archon.runtime

/**
 * Applies credentials as the innermost middleware. This stub only runs [ClientOptions.customAuth]; scheme
 * selection and the built-in schemes are added with the auth task.
 */
internal class AuthMiddleware(private val core: ApiClientCore) : Middleware {
    override suspend fun intercept(request: ApiRequest, next: suspend (ApiRequest) -> ApiResponse, context: CallContext): ApiResponse {
        core.options.customAuth?.invoke(request, context)
        return next(request)
    }
}
