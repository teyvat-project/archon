package archon.runtime

import kotlinx.serialization.json.Json

/** The JSON configuration shared by every generated model and request. */
public val ApiJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = true
}
