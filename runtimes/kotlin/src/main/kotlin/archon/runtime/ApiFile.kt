package archon.runtime

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlin.io.encoding.Base64

/** File content for binary and multipart bodies. Inside JSON it is a base64 string. */
@Serializable(with = ApiFile.Serializer::class)
public class ApiFile(
    public val content: ByteArray,
    /** The multipart `filename` (`"blob"` when `null`). */
    public val fileName: String? = null,
    /** The part's (or binary body's) Content-Type; `null` uses the operation's media type. */
    public val contentType: String? = null,
) {
    /** Reads and writes the content as a base64 string (file name and type are not part of JSON). */
    public object Serializer : KSerializer<ApiFile> {
        override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("archon.runtime.ApiFile", PrimitiveKind.STRING)

        override fun serialize(encoder: Encoder, value: ApiFile) {
            encoder.encodeString(Base64.encode(value.content))
        }

        override fun deserialize(decoder: Decoder): ApiFile {
            val text = decoder.decodeString()
            val bytes = try {
                Base64.decode(text)
            } catch (e: IllegalArgumentException) {
                throw SerializationException("Invalid base64 file content: ${e.message}", e)
            }
            return ApiFile(bytes)
        }
    }
}
