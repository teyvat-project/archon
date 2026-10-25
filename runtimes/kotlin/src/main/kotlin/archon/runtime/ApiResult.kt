package archon.runtime

/** A successful response and its decoded body. */
public class ApiResult<out T>(
    public val statusCode: Int,
    public val headers: ApiHeaders,
    /** The final request URL (after redirects). */
    public val url: String,
    public val data: T,
)
