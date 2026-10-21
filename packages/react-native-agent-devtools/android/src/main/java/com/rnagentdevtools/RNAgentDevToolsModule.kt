package com.rnagentdevtools

import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.util.Base64
import android.view.InputDevice
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.RootView
import com.facebook.react.uimanager.TouchTargetHelper
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.common.UIManagerType
import com.facebook.react.views.modal.ReactModalHostView
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Android side of react-native-agent-devtools.
 *
 * Taps, long presses and swipes are synthesized MotionEvents dispatched through the
 * target window's own view hierarchy (decor view). They exercise real hit-testing,
 * `pointerEvents`, RN's JSTouchDispatcher and Pressability — but they are not
 * injected by the OS input system (that requires instrumentation/adb), so results
 * report mode = "synthesized-touch".
 *
 * Every method refuses to run unless the app is debuggable.
 */
class RNAgentDevToolsModule(reactContext: ReactApplicationContext) :
  NativeRNAgentDevToolsSpec(reactContext) {

  private val main = Handler(Looper.getMainLooper())

  private val debuggable: Boolean
    get() = (reactApplicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  private val density: Float
    get() = reactApplicationContext.resources.displayMetrics.density

  override fun getTypedExportedConstants(): MutableMap<String, Any> {
    val ctx = reactApplicationContext
    val label = ctx.applicationInfo.loadLabel(ctx.packageManager).toString()
    return mutableMapOf(
      "isDebuggable" to debuggable,
      "isEmulator" to isEmulator(),
      "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
      "osVersion" to Build.VERSION.RELEASE,
      "appName" to label,
      "bundleId" to ctx.packageName,
    )
  }

  private fun isEmulator(): Boolean =
    Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
      Build.MODEL.contains("Emulator") || Build.MODEL.contains("Android SDK built for") ||
      Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") ||
      Build.PRODUCT.contains("sdk")

  /** Runs [block] on the UI thread with uniform gating and error mapping. */
  private inline fun onUi(promise: Promise, crossinline block: () -> Unit) {
    if (!debuggable) {
      promise.reject("RNAD_DISABLED", "react-native-agent-devtools is disabled in non-debuggable builds")
      return
    }
    UiThreadUtil.runOnUiThread {
      try {
        block()
      } catch (e: Throwable) {
        promise.reject("RNAD_NATIVE_ERROR", e.message ?: e.toString(), e)
      }
    }
  }

  private fun resolveView(tag: Int): View? {
    val uiManager = UIManagerHelper.getUIManager(reactApplicationContext, UIManagerType.FABRIC) ?: return null
    return try {
      uiManager.resolveView(tag)
    } catch (e: Exception) {
      null
    }
  }

  private fun isShown(v: View): Boolean {
    if (!v.isAttachedToWindow || !v.isShown || v.windowVisibility != View.VISIBLE) return false
    var cur: View? = v
    while (cur != null) {
      if (cur.alpha < 0.01f) return false
      cur = cur.parent as? View
    }
    return true
  }

  /** Nearest ancestor implementing RN's RootView (surface root or modal DialogRootViewGroup). */
  private fun reactRootOf(v: View): ViewGroup? {
    var cur: View? = v
    while (cur != null) {
      if (cur is RootView && cur is ViewGroup) return cur
      cur = cur.parent as? View
    }
    return null
  }

  private fun <T : View> descendantOf(v: View, cls: Class<T>, depth: Int): T? {
    if (cls.isInstance(v)) return cls.cast(v)
    if (depth == 0 || v !is ViewGroup) return null
    for (i in 0 until v.childCount) {
      descendantOf(v.getChildAt(i), cls, depth - 1)?.let { return it }
    }
    return null
  }

  private inline fun <reified T : View> findDescendant(v: View): T? = descendantOf(v, T::class.java, 5)

  private fun windowPoint(v: View, dx: Double, dy: Double): Pair<Float, Float> {
    val loc = IntArray(2)
    v.getLocationInWindow(loc)
    return Pair(loc[0] + (dx * density).toFloat(), loc[1] + (dy * density).toFloat())
  }

  // ---- Environment -------------------------------------------------------

  override fun getSafeAreaInsets(promise: Promise) = onUi(promise) {
    val map = Arguments.createMap()
    val decor = reactApplicationContext.currentActivity?.window?.decorView
    val insets = decor?.rootWindowInsets
    val d = density
    if (insets != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val i = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
      map.putDouble("top", (i.top / d).toDouble())
      map.putDouble("bottom", (i.bottom / d).toDouble())
      map.putDouble("left", (i.left / d).toDouble())
      map.putDouble("right", (i.right / d).toDouble())
    } else {
      @Suppress("DEPRECATION")
      map.putDouble("top", ((insets?.systemWindowInsetTop ?: 0) / d).toDouble())
      @Suppress("DEPRECATION")
      map.putDouble("bottom", ((insets?.systemWindowInsetBottom ?: 0) / d).toDouble())
      map.putDouble("left", 0.0)
      map.putDouble("right", 0.0)
    }
    promise.resolve(map)
  }

  // ---- Probe --------------------------------------------------------------

  override fun probeViews(tags: ReadableArray, offsets: ReadableArray, promise: Promise) = onUi(promise) {
    val shown = Arguments.createArray()
    val hits = Arguments.createArray()
    for (i in 0 until tags.size()) {
      val v = resolveView(tags.getInt(i))
      if (v == null) {
        shown.pushBoolean(false)
        hits.pushInt(-1)
        continue
      }
      val visible = isShown(v)
      shown.pushBoolean(visible)
      val dx = if (2 * i < offsets.size()) offsets.getDouble(2 * i) else -1.0
      val dy = if (2 * i + 1 < offsets.size()) offsets.getDouble(2 * i + 1) else -1.0
      if (!visible || dx < 0 || dy < 0) {
        hits.pushInt(-1)
        continue
      }
      val root = reactRootOf(v)
      if (root == null || !root.hasWindowFocus()) {
        // Another window (dialog, system UI) owns input focus above this one.
        hits.pushInt(0)
        continue
      }
      val (wx, wy) = windowPoint(v, dx, dy)
      val rootLoc = IntArray(2)
      root.getLocationInWindow(rootLoc)
      hits.pushInt(TouchTargetHelper.findTargetTagForTouch(wx - rootLoc[0], wy - rootLoc[1], root))
    }
    val result = Arguments.createMap()
    result.putArray("shown", shown)
    result.putArray("hit", hits)
    promise.resolve(result)
  }

  // ---- Touch synthesis ----------------------------------------------------

  private fun obtain(downTime: Long, action: Int, x: Float, y: Float): MotionEvent {
    val props = MotionEvent.PointerProperties().apply {
      id = 0
      toolType = MotionEvent.TOOL_TYPE_FINGER
    }
    val coords = MotionEvent.PointerCoords().apply {
      this.x = x
      this.y = y
      pressure = 1f
      size = 1f
    }
    return MotionEvent.obtain(
      downTime, SystemClock.uptimeMillis(), action, 1, arrayOf(props), arrayOf(coords),
      0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
    )
  }

  private fun dispatch(root: View, ev: MotionEvent): Boolean = try {
    root.dispatchTouchEvent(ev)
  } finally {
    ev.recycle()
  }

  private fun touchResult(x: Float, y: Float, handled: Boolean): WritableMap = Arguments.createMap().apply {
    putString("mode", "synthesized-touch")
    putDouble("x", (x / density).toDouble())
    putDouble("y", (y / density).toDouble())
    putBoolean("handled", handled)
  }

  override fun tap(tag: Double, dx: Double, dy: Double, promise: Promise) =
    pressAndRelease(tag.toInt(), dx, dy, 60L, promise)

  override fun longPress(tag: Double, dx: Double, dy: Double, durationMs: Double, promise: Promise) =
    pressAndRelease(tag.toInt(), dx, dy, max(500.0, durationMs).toLong(), promise)

  private fun pressAndRelease(tag: Int, dx: Double, dy: Double, holdMs: Long, promise: Promise) = onUi(promise) {
    val v = resolveView(tag)
    if (v == null || !isShown(v)) {
      promise.reject("RNAD_NOT_FOUND", "No visible native view for tag $tag")
      return@onUi
    }
    val root = v.rootView
    val (x, y) = windowPoint(v, dx, dy)
    // Re-check at dispatch time: layout may have moved since JS hit-tested (keyboard,
    // animations). Never deliver a touch that a finger would land on something else.
    val reactRoot = reactRootOf(v)
    if (reactRoot != null) {
      val rootLoc = IntArray(2)
      reactRoot.getLocationInWindow(rootLoc)
      val targetTag = TouchTargetHelper.findTargetTagForTouch(x - rootLoc[0], y - rootLoc[1], reactRoot)
      var hit: View? = resolveView(targetTag)
      while (hit != null && hit !== v) hit = hit.parent as? View
      if (hit == null || !reactRoot.hasWindowFocus()) {
        promise.reject("RNAD_NOT_HITTABLE", "A touch at the element's center would land on view #$targetTag, not on #$tag")
        return@onUi
      }
    }
    val downTime = SystemClock.uptimeMillis()
    val handled = dispatch(root, obtain(downTime, MotionEvent.ACTION_DOWN, x, y))
    main.postDelayed({
      try {
        dispatch(root, obtain(downTime, MotionEvent.ACTION_UP, x, y))
        promise.resolve(touchResult(x, y, handled))
      } catch (e: Throwable) {
        promise.reject("RNAD_NATIVE_ERROR", e.message ?: e.toString(), e)
      }
    }, holdMs)
  }

  override fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) = onUi(promise) {
    val root = reactApplicationContext.currentActivity?.window?.decorView
    if (root == null) {
      promise.reject("RNAD_NO_WINDOW", "No current activity")
      return@onUi
    }
    val d = density
    val sx = (x1 * d).toFloat()
    val sy = (y1 * d).toFloat()
    val ex = (x2 * d).toFloat()
    val ey = (y2 * d).toFloat()
    val steps = max(2, (min(2000.0, max(50.0, durationMs)) / 16.0).roundToInt())
    val downTime = SystemClock.uptimeMillis()
    dispatch(root, obtain(downTime, MotionEvent.ACTION_DOWN, sx, sy))
    var step = 1
    val tick = object : Runnable {
      override fun run() {
        try {
          val t = step.toFloat() / steps
          val x = sx + (ex - sx) * t
          val y = sy + (ey - sy) * t
          if (step < steps) {
            dispatch(root, obtain(downTime, MotionEvent.ACTION_MOVE, x, y))
            step++
            main.postDelayed(this, 16)
          } else {
            dispatch(root, obtain(downTime, MotionEvent.ACTION_MOVE, ex, ey))
            dispatch(root, obtain(downTime, MotionEvent.ACTION_UP, ex, ey))
            promise.resolve(touchResult(ex, ey, true))
          }
        } catch (e: Throwable) {
          promise.reject("RNAD_NATIVE_ERROR", e.message ?: e.toString(), e)
        }
      }
    }
    main.postDelayed(tick, 16)
  }

  // ---- Text -----------------------------------------------------------------

  override fun typeText(tag: Double, text: String, replace: Boolean, submit: Boolean, promise: Promise) = onUi(promise) {
    val v = resolveView(tag.toInt())
    val et = v?.let { findDescendant<EditText>(it) }
    if (et == null) {
      promise.reject("RNAD_NOT_TEXT_INPUT", "View ${tag.toInt()} contains no EditText")
      return@onUi
    }
    if (!et.isEnabled) {
      promise.reject("RNAD_DISABLED", "EditText is disabled")
      return@onUi
    }
    et.requestFocus()
    val editable = et.text
    if (replace) {
      editable.replace(0, editable.length, text)
    } else {
      val s = max(0, min(et.selectionStart, et.selectionEnd))
      val e = max(0, max(et.selectionStart, et.selectionEnd))
      editable.replace(s, e, text)
    }
    et.setSelection(et.text.length)
    var submitted = false
    if (submit) {
      val action = (et.imeOptions and EditorInfo.IME_MASK_ACTION).takeIf { it != EditorInfo.IME_ACTION_UNSPECIFIED }
        ?: EditorInfo.IME_ACTION_DONE
      et.onEditorAction(action)
      submitted = true
    }
    val variation = et.inputType and InputType.TYPE_MASK_VARIATION
    val secure = et.transformationMethod is PasswordTransformationMethod ||
      variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
      variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
      variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    val result = Arguments.createMap()
    result.putString("mode", "native")
    result.putInt("length", et.text.length)
    result.putBoolean("secure", secure)
    result.putBoolean("submitted", submitted)
    if (!secure) result.putString("value", et.text.toString())
    promise.resolve(result)
  }

  // ---- Scroll ---------------------------------------------------------------

  override fun scrollBy(tag: Double, dx: Double, dy: Double, animated: Boolean, promise: Promise) = onUi(promise) {
    val v = resolveView(tag.toInt())
    val sv: ViewGroup? = v?.let { findDescendant<ScrollView>(it) ?: findDescendant<HorizontalScrollView>(it) }
    if (sv == null || sv.childCount == 0) {
      promise.reject("RNAD_NOT_SCROLLABLE", "View ${tag.toInt()} contains no ScrollView")
      return@onUi
    }
    val d = density
    val child = sv.getChildAt(0)
    val maxX = max(0, child.width - (sv.width - sv.paddingLeft - sv.paddingRight))
    val maxY = max(0, child.height - (sv.height - sv.paddingTop - sv.paddingBottom))
    val bx = sv.scrollX
    val by = sv.scrollY
    val tx = min(max(0, bx + (dx * d).roundToInt()), maxX)
    val ty = min(max(0, by + (dy * d).roundToInt()), maxY)
    if (animated) {
      when (sv) {
        is ScrollView -> sv.smoothScrollTo(tx, ty)
        is HorizontalScrollView -> sv.smoothScrollTo(tx, ty)
      }
    } else {
      sv.scrollTo(tx, ty)
    }
    fun pt(x: Int, y: Int) = Arguments.createMap().apply {
      putDouble("x", (x / d).toDouble())
      putDouble("y", (y / d).toDouble())
    }
    val result = Arguments.createMap()
    result.putString("mode", "native")
    result.putMap("before", pt(bx, by))
    result.putMap("after", pt(tx, ty))
    result.putMap("max", pt(maxX, maxY))
    result.putMap("viewport", Arguments.createMap().apply {
      putDouble("width", (sv.width / d).toDouble())
      putDouble("height", (sv.height / d).toDouble())
    })
    result.putBoolean("moved", abs(tx - bx) > 0 || abs(ty - by) > 0)
    promise.resolve(result)
  }

  // ---- Back -------------------------------------------------------------------

  override fun pressBack(promise: Promise) = onUi(promise) {
    val activity = reactApplicationContext.currentActivity as? ComponentActivity
    if (activity == null) {
      promise.reject("RNAD_NO_WINDOW", "No current activity")
      return@onUi
    }
    activity.onBackPressedDispatcher.onBackPressed()
    promise.resolve(Arguments.createMap().apply { putString("mode", "native") })
  }

  // ---- Screenshot ---------------------------------------------------------------

  override fun captureScreen(maxWidth: Double, quality: Double, boxes: ReadableArray, labels: ReadableArray, promise: Promise) = onUi(promise) {
    val activity = reactApplicationContext.currentActivity
    val decor = activity?.window?.decorView
    if (activity == null || decor == null || decor.width == 0 || decor.height == 0) {
      promise.reject("RNAD_NO_WINDOW", "No visible activity window")
      return@onUi
    }
    val started = SystemClock.elapsedRealtime()
    val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
    val finish = {
      try {
        val canvas = Canvas(bitmap)
        drawModalWindows(decor, canvas)
        drawBoxes(canvas, boxes, labels)
        promise.resolve(encode(bitmap, maxWidth, quality, started))
      } catch (e: Throwable) {
        promise.reject("RNAD_NATIVE_ERROR", e.message ?: e.toString(), e)
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PixelCopy.request(activity.window, bitmap, { result ->
        if (result != PixelCopy.SUCCESS) decor.draw(Canvas(bitmap))
        finish()
      }, main)
    } else {
      decor.draw(Canvas(bitmap))
      finish()
    }
  }

  /** RN modals live in their own Dialog windows, which PixelCopy of the activity window misses. */
  private fun drawModalWindows(decor: View, canvas: Canvas) {
    val modals = mutableListOf<ReactModalHostView>()
    fun collect(v: View) {
      if (v is ReactModalHostView) modals.add(v)
      if (v is ViewGroup) for (i in 0 until v.childCount) collect(v.getChildAt(i))
    }
    collect(decor)
    val decorLoc = IntArray(2)
    decor.getLocationOnScreen(decorLoc)
    for (m in modals) {
      val dialogDecor = m.dialog?.takeIf { it.isShowing }?.window?.decorView ?: continue
      val loc = IntArray(2)
      dialogDecor.getLocationOnScreen(loc)
      canvas.save()
      canvas.translate((loc[0] - decorLoc[0]).toFloat(), (loc[1] - decorLoc[1]).toFloat())
      dialogDecor.draw(canvas)
      canvas.restore()
    }
  }

  private fun drawBoxes(canvas: Canvas, boxes: ReadableArray, labels: ReadableArray) {
    if (boxes.size() < 4) return
    val d = density
    val stroke = Paint().apply {
      color = Color.argb(240, 217, 89, 51)
      style = Paint.Style.STROKE
      strokeWidth = 1.5f * d
    }
    val fill = Paint().apply { color = Color.argb(240, 217, 89, 51) }
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = 10f * d
      isFakeBoldText = true
    }
    var i = 0
    while (i + 3 < boxes.size()) {
      val l = (boxes.getDouble(i) * d).toFloat()
      val t = (boxes.getDouble(i + 1) * d).toFloat()
      val r = l + (boxes.getDouble(i + 2) * d).toFloat()
      val b = t + (boxes.getDouble(i + 3) * d).toFloat()
      canvas.drawRect(l, t, r, b, stroke)
      val idx = i / 4
      if (idx < labels.size()) {
        val label = labels.getString(idx) ?: ""
        val bounds = Rect()
        text.getTextBounds(label, 0, label.length, bounds)
        val top = max(0f, t - bounds.height() - 4 * d)
        canvas.drawRect(l, top, l + bounds.width() + 4 * d, top + bounds.height() + 4 * d, fill)
        canvas.drawText(label, l + 2 * d, top + bounds.height() + 2 * d, text)
      }
      i += 4
    }
  }

  private fun encode(bitmap: Bitmap, maxWidth: Double, quality: Double, started: Long): WritableMap {
    val scaled = if (maxWidth > 0 && bitmap.width > maxWidth) {
      val h = (bitmap.height * (maxWidth / bitmap.width)).roundToInt()
      Bitmap.createScaledBitmap(bitmap, maxWidth.roundToInt(), h, true)
    } else {
      bitmap
    }
    val png = quality >= 1.0
    val out = ByteArrayOutputStream()
    scaled.compress(
      if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG,
      if (png) 100 else (max(0.1, quality) * 100).roundToInt(),
      out,
    )
    val d = density
    return Arguments.createMap().apply {
      putString("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
      putString("mimeType", if (png) "image/png" else "image/jpeg")
      putInt("width", scaled.width)
      putInt("height", scaled.height)
      putDouble("pointWidth", (bitmap.width / d).toDouble())
      putDouble("pointHeight", (bitmap.height / d).toDouble())
      putDouble("scale", scaled.width.toDouble() / (bitmap.width / d))
      putDouble("captureMs", (SystemClock.elapsedRealtime() - started).toDouble())
    }
  }

  // ---- Native overlays -------------------------------------------------------------

  override fun getNativeOverlays(promise: Promise) = onUi(promise) {
    val overlays = Arguments.createArray()
    val activity: Activity? = reactApplicationContext.currentActivity
    if (activity is FragmentActivity) {
      for (f in activity.supportFragmentManager.fragments) {
        val dialog = (f as? DialogFragment)?.dialog ?: continue
        if (!dialog.isShowing) continue
        val entry = Arguments.createMap()
        entry.putString("type", "alert")
        val message = dialog.findViewById<TextView>(android.R.id.message)?.text?.toString() ?: ""
        entry.putString("message", message)
        val actions = Arguments.createArray()
        if (dialog is AlertDialog) {
          for (which in listOf(DialogInterface.BUTTON_POSITIVE, DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_NEUTRAL)) {
            val button = dialog.getButton(which) ?: continue
            if (button.visibility != View.VISIBLE) continue
            actions.pushMap(Arguments.createMap().apply { putString("title", button.text.toString()) })
          }
        } else if (dialog is androidx.appcompat.app.AlertDialog) {
          for (which in listOf(DialogInterface.BUTTON_POSITIVE, DialogInterface.BUTTON_NEGATIVE, DialogInterface.BUTTON_NEUTRAL)) {
            val button = dialog.getButton(which) ?: continue
            if (button.visibility != View.VISIBLE) continue
            actions.pushMap(Arguments.createMap().apply { putString("title", button.text.toString()) })
          }
        }
        entry.putArray("actions", actions)
        overlays.pushMap(entry)
      }
    }
    val result = Arguments.createMap()
    result.putArray("overlays", overlays)
    promise.resolve(result)
  }

  companion object {
    const val NAME = NativeRNAgentDevToolsSpec.NAME
  }
}
