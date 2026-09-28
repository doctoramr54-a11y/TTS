// ============================================================
// Edge TTS Cloudflare Worker - نسخة معدلة لدعم الأصوات العربية
// ============================================================

const encoder = new TextEncoder();

// يمكنك تعيين API_KEY عبر Environment Variables في Cloudflare
// إذا لم يتم تعيينه، سيعمل Worker بدون مصادقة.
const API_KEY = globalThis.API_KEY;

// إعدادات تجديد التوكن
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60; // تجديد قبل 5 دقائق من الانتهاء

let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

// خريطة تحويل أسماء الأصوات المتوافقة مع OpenAI إلى أصوات Edge TTS
const VOICE_MAPPING = {
    'alloy':   'zh-CN-XiaoxiaoNeural',
    'echo':    'zh-CN-YunxiNeural',
    'fable':   'zh-CN-XiaoyiNeural',
    'onyx':    'zh-CN-YunyangNeural',
    'nova':    'zh-CN-XiaohanNeural',
    'shimmer': 'zh-CN-XiaomengNeural',

    // اختصارات عربية (يمكنك استخدامها مباشرة)
    'salma':   'ar-EG-SalmaNeural',
    'zariyah': 'ar-SA-ZariyahNeural',
    'hamed':   'ar-SA-HamedNeural',
    'amina':   'ar-EG-AminaNeural'
};

// ============================================================
// نقطة الدخول
// ============================================================
addEventListener("fetch", event => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    // معالجة طلبات OPTIONS (CORS Preflight)
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }

    // التحقق من المصادقة (فقط إذا تم تعيين API_KEY)
    if (API_KEY) {
        const authHeader = request.headers.get("authorization");
        const apiKey = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;

        if (apiKey !== API_KEY) {
            return new Response(JSON.stringify({
                error: {
                    message: "Invalid API key. Use 'Authorization: Bearer your-api-key' header",
                    type: "invalid_request_error",
                    param: null,
                    code: "invalid_api_key"
                }
            }), {
                status: 401,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // المسار المتوافق مع OpenAI
    if (path === "/v1/audio/speech") {
        try {
            const requestBody = await request.json();
            let {
                model = "tts-1",
                input,
                voice = "ar-EG-SalmaNeural",   // ← الصوت الافتراضي الآن عربي
                response_format = "mp3",
                speed = 1.0,
                pitch = 1.0,
                style = "general"
            } = requestBody;

            // التحقق من وجود النص
            if (!input || typeof input !== "string") {
                return new Response(JSON.stringify({
                    error: {
                        message: "Parameter 'input' is required and must be a string.",
                        type: "invalid_request_error",
                        param: "input",
                        code: "missing_input"
                    }
                }), {
                    status: 400,
                    headers: {
                        "Content-Type": "application/json",
                        ...makeCORSHeaders()
                    }
                });
            }

            // تطبيق خريطة الأصوات إن وُجد
            voice = VOICE_MAPPING[voice] || voice;

            // تحويل speed / pitch إلى نسب مئوية
            const rate = ((speed - 1) * 100).toFixed(0);
            const numPitch = ((pitch - 1) * 100).toFixed(0);

            const response = await getVoice(
                input,
                voice,
                rate,
                numPitch,
                style,
                "audio-24khz-48kbitrate-mono-mp3",
                false
            );

            return response;

        } catch (error) {
            console.error("Error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message,
                    type: "api_error",
                    param: null,
                    code: "edge_tts_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    // مسار بسيط لفحص الحالة
    if (path === "/" || path === "/health") {
        return new Response(JSON.stringify({
            status: "ok",
            service: "edge-tts-worker",
            default_voice: "ar-EG-SalmaNeural"
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }

    return new Response("Not Found", { status: 404 });
}

// ============================================================
// معالجة CORS
// ============================================================
async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers":
                request.headers.get("Access-Control-Request-Headers") || "Authorization, Content-Type"
        }
    });
}

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
        "Access-Control-Max-Age": "86400"
    };
}

// ============================================================
// توليد الصوت
// ============================================================
async function getVoice(
    text,
    voiceName = "ar-EG-SalmaNeural",
    rate = 0,
    pitch = 0,
    style = "general",
    outputFormat = "audio-24khz-48kbitrate-mono-mp3",
    download = false
) {
    try {
        const maxChunkSize = 2000;
        const chunks = [];

        // تقسيم النص الطويل إلى أجزاء
        for (let i = 0; i < text.length; i += maxChunkSize) {
            chunks.push(text.slice(i, i + maxChunkSize));
        }

        // ⚠️ المعالجة المتسلسلة لتجنب خطأ 429 من Edge TTS
        const audioChunks = [];
        for (const chunk of chunks) {
            const audioBlob = await getAudioChunk(
                chunk, voiceName, rate, pitch, style, outputFormat
            );
            audioChunks.push(audioBlob);
        }

        const concatenatedAudio = new Blob(audioChunks, { type: "audio/mpeg" });
        const headers = {
            "Content-Type": "audio/mpeg",
            ...makeCORSHeaders()
        };

        if (download) {
            headers["Content-Disposition"] = `attachment; filename="${uuid()}.mp3"`;
        }

        return new Response(concatenatedAudio, { headers });

    } catch (error) {
        console.error("语音合成失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: error.message,
                type: "api_error",
                param: null,
                code: "edge_tts_error"
            }
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }
}

// الحصول على جزء واحد من الصوت
async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat) {
    const endpoint = await getEndpoint();
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
            "Authorization": endpoint.t,
            "Content-Type": "application/ssml+xml",
            "User-Agent": "okhttp/4.5.0",
            "X-Microsoft-OutputFormat": outputFormat
        },
        body: getSsml(text, voiceName, rate, pitch, style)
    }, 30000);

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
    }

    return response.blob();
}

// ============================================================
// بناء SSML - النسخة المعدلة لدعم العربية
// ============================================================
function getSsml(text, voiceName, rate, pitch, style) {
    // استخراج اللغة من اسم الصوت (ar-EG-SalmaNeural ➡️ ar-EG)
    const lang = voiceName.split("-").slice(0, 2).join("-") || "en-US";

    // لا نستخدم express-as إلا إذا كان النمط محددًا وليس "general"
    // لأن معظم الأصوات العربية لا تدعم الأنماط
    const useStyle = style && style !== "general";
    const styleOpen = useStyle
        ? `<mstts:express-as style="${style}" styledegree="1.0" role="default">`
        : "";
    const styleClose = useStyle ? "</mstts:express-as>" : "";

    // تهريب الرموز الخاصة في النص
    const safeText = escapeXml(text);

    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="${lang}">
    <voice name="${voiceName}">
        ${styleOpen}
            <prosody rate="${rate}%" pitch="${pitch}%" volume="100">${safeText}</prosody>
        ${styleClose}
    </voice>
</speak>`;
}

// تهريب الرموز الخاصة لتفادي كسر SSML
function escapeXml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ============================================================
// إدارة التوكن ونقطة النهاية
// ============================================================
async function getEndpoint() {
    const now = Date.now() / 1000;

    // استخدام التوكن المخزن إذا كان لا يزال صالحًا
    if (
        tokenInfo.token &&
        tokenInfo.expiredAt &&
        now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY
    ) {
        console.log(`使用缓存的token，剩余 ${((tokenInfo.expiredAt - now) / 60).toFixed(1)} 分钟`);
        return tokenInfo.endpoint;
    }

    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");

    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": "okhttp/4.5.0",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0",
                "Accept-Encoding": "gzip"
            }
        });

        if (!response.ok) {
            throw new Error(`获取endpoint失败: ${response.status}`);
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));

        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        console.log(`获取新token成功，有效期 ${((decodedJwt.exp - now) / 60).toFixed(1)} 分钟`);
        return data;

    } catch (error) {
        console.error("获取endpoint失败:", error);

        // استخدام التوكن المنتهي كحل احتياطي
        if (tokenInfo.token) {
            console.log("使用过期的缓存token");
            return tokenInfo.endpoint;
        }
        throw error;
    }
}

// ============================================================
// دوال مساعدة
// ============================================================
async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(data)
    );
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign =
        `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();

    const decode = await base64ToBytes(
        "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="
    );
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);

    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
    return formattedDate.toLowerCase();
}

// ============================================================
// fetch مع مهلة زمنية
// ============================================================
async function fetchWithTimeout(url, options, timeout = 30000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}