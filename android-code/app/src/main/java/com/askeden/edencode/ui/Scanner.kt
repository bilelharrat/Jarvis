package com.askeden.edencode.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.askeden.edencode.net.PairPayload
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Scan QR code (PairScanner.swift): the camera, reading the Mac's pairing code (Eden Code › On
 * your phone). CameraX shows the camera and hands frames to ZXing (no Google Play services
 * needed). The first code that parses goes back ([onScan]); another QR code says what's wrong
 * and it keeps looking. Asks for the camera first; if it's refused, says how to turn it on, or
 * to type the code instead. Cost policy: no model calls, nothing leaves the phone.
 */
@Composable
fun QrScanner(onCancel: () -> Unit, onScan: (PairPayload) -> Unit) {
    val context = LocalContext.current
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    fun granted() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    var access by remember { mutableStateOf(if (!hasCamera) "none" else if (granted()) "yes" else "ask") }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> access = if (ok) "yes" else "no" }
    LaunchedEffect(Unit) { if (access == "ask") ask.launch(Manifest.permission.CAMERA) }
    var problem by remember { mutableStateOf<String?>(null) }

    EdenTheme(dark = true) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when (access) {
                "yes" -> {
                    CameraPreview(
                        onText = { text ->
                            when (val parsed = PairPayload.parse(text)) {
                                is PairPayload.Parsed.Ok -> { onScan(parsed.payload); true }
                                is PairPayload.Parsed.Refused -> { problem = PairPayload.message(parsed.problem); false }
                            }
                        },
                    )
                    ScanCorners(Modifier.align(Alignment.Center).size(240.dp))
                    T(
                        problem ?: "Point at the QR code in Eden Code › On your phone on your Mac.",
                        sf(15f, Medium), if (problem == null) Color.White else hex(0xFFB340),
                        Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = safeBottom() + 8.dp).fillMaxWidth()
                            .gGlass(null, 20.dp, tint = hex(0x2C2C30, 0.85f)).padding(horizontal = 18.dp, vertical = 14.dp),
                        align = TextAlign.Center,
                    )
                }
                "no", "none" -> Column(
                    Modifier.align(Alignment.Center).padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    T(if (access == "none") "No camera here" else "Camera is off for Eden Code", sf(20f, Semibold), Color.White, align = TextAlign.Center)
                    T(
                        if (access == "none") "Type the six-digit code your Mac shows instead."
                        else "Turn it on in Settings to scan, or type the six-digit code your Mac shows.",
                        sf(15f), hex(0xC7C7CC), align = TextAlign.Center,
                    )
                    if (access == "no") GlassButton("Open Settings", true, height = 44.dp) {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                    }
                }
                else -> {}
            }
            // A dark fade at the top, so the bar reads over a bright scene.
            Box(Modifier.fillMaxWidth().height(safeTop() + 80.dp).background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent))))
            // The bar: Cancel and the title, as iOS's inline navigation bar over the camera.
            Box(Modifier.fillMaxWidth().padding(top = safeTop() - 6.dp, start = 16.dp, end = 16.dp).height(52.dp)) {
                GlassButton("Cancel", false, Modifier.align(Alignment.CenterStart), height = 44.dp, style = sf(17f), onClick = onCancel)
                T("Scan QR code", sf(17f, Semibold), Color.White, Modifier.align(Alignment.Center).semantics { heading() }, maxLines = 1)
            }
        }
    }
}

/** The camera, bound to this screen's lifecycle, its frames read for QR codes until [onText] takes one. */
@Composable
private fun CameraPreview(onText: (String) -> Boolean) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val done = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val main = remember { ContextCompat.getMainExecutor(context) }
    var lastRefused by remember { mutableStateOf<String?>(null) }
    val reader = remember { QrDecode.reader() }
    val view = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(executor) { image ->
                val text = decode(reader, image)
                image.close()
                if (text != null && !done.get() && text != lastRefused) {
                    main.execute {
                        if (done.get()) return@execute
                        if (onText(text)) done.set(true) else lastRefused = text
                    }
                }
            }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }
        }, main)
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
            executor.shutdown()
        }
    }
    AndroidView({ view }, Modifier.fillMaxSize())
}

/** The frame's brightness (its Y plane) through ZXing; null when there's no QR code in it. */
private fun decode(reader: MultiFormatReader, image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val stride = plane.rowStride
    val width = image.width
    val height = image.height
    val data = ByteArray(width * height)
    buffer.rewind()
    for (row in 0 until height) {
        buffer.position(row * stride)
        buffer.get(data, row * width, minOf(width, buffer.remaining()))
    }
    return QrDecode.text(reader, data, width, height)
}

/** One frame's brightness (row after row, one byte a pixel) to the QR code's text; null when there's none. */
object QrDecode {
    fun reader(): MultiFormatReader = MultiFormatReader().apply {
        setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
    }

    fun text(reader: MultiFormatReader, luminance: ByteArray, width: Int, height: Int): String? = try {
        reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false)))).text
    } catch (_: NotFoundException) {
        null
    } catch (_: Exception) {
        null
    } finally {
        reader.reset()
    }
}

/** The four white corners around where the code goes. */
@Composable
private fun ScanCorners(modifier: Modifier) {
    Canvas(modifier) {
        val w = 4.dp.toPx()
        val l = 36.dp.toPx()
        val s = size
        fun corner(x: Float, y: Float, dx: Float, dy: Float) {
            drawLine(Color.White, Offset(x, y), Offset(x + dx * l, y), w, StrokeCap.Round)
            drawLine(Color.White, Offset(x, y), Offset(x, y + dy * l), w, StrokeCap.Round)
        }
        corner(0f, 0f, 1f, 1f); corner(s.width, 0f, -1f, 1f); corner(0f, s.height, 1f, -1f); corner(s.width, s.height, -1f, -1f)
    }
}
