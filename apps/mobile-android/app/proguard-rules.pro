# R8 / ProGuard rules. Compose + AndroidX + OkHttp + Retrofit have
# default rules shipped with their AARs; we only need extras for
# kotlinx.serialization (reflection-free codegen) and our own
# DTO classes (kept by @Serializable's class-level marker, no need
# to spell each one out).

# kotlinx.serialization — keep generated $serializer companions.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class **$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class * {
    kotlinx.serialization.KSerializer serializer(...);
}

# Retrofit + OkHttp — covered by their consumer rules but pin them
# explicitly so future R8 versions don't surprise us.
-keepclasseswithmembers,allowobfuscation interface * {
    @retrofit2.http.* <methods>;
}
-keep,allowobfuscation,allowshrinking class kotlin.Result
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation

# Our DTOs — kept via the @Serializable rules above. No additional
# rules needed unless we add reflection-using libraries later.
