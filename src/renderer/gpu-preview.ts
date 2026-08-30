import { evaluateCurve } from '../core/reconstruct';
import { srgbToLinear } from '../core/image';
import { getFilmStockProfile } from '../shared/film-stock-profiles';
import { getMeasuredHdLuts } from '../shared/measured-stock-profiles';
import type { EditRecipe, Matrix9, RGB } from '../shared/types';

const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D sourcePixels;
uniform sampler2D curvePixels;
uniform ivec2 imageSize;
uniform bool densityEnabled;
uniform bool splitCompare;
uniform int densityMode;
uniform int lookMode;
uniform bool blackAndWhite;
uniform vec3 baseLinear;
uniform vec3 densityLow;
uniform vec3 densityHigh;
uniform vec3 correctionShadow;
uniform vec3 correctionMid;
uniform vec3 correctionHighlight;
uniform vec3 separationRow0;
uniform vec3 separationRow1;
uniform vec3 separationRow2;
uniform float separationAmount;
uniform float toeKnee;
uniform float shoulderKnee;
uniform vec3 lightScales;
uniform float exposure;
uniform vec3 gains;
uniform float contrastAmount;
uniform float inverseGamma;
uniform float saturationAmount;
uniform float vibranceAmount;
uniform float shadowAmount;
uniform float highlightAmount;
uniform float highlightRolloff;
uniform float fadeAmount;
uniform float lookStrength;
uniform vec4 cmyDensity;
uniform vec3 vignette;
out vec4 outputColor;

float sat(float value) { return clamp(value, 0.0, 1.0); }
vec3 sat3(vec3 value) { return clamp(value, vec3(0.0), vec3(1.0)); }
float linearToSrgb(float value) { value = sat(value); return value <= 0.0031308 ? value * 12.92 : 1.055 * pow(value, 1.0 / 2.4) - 0.055; }
float compressHighlight(float value) {
  float amount = sat(highlightRolloff / 100.0) * 1.6;
  if (value <= 1.0 || amount <= 0.0) return value;
  float excess = value - 1.0;
  return 1.0 + excess / (1.0 + amount * excess);
}
float filmic(float value) {
  float x = max(0.0, value); const float A=.22, B=.30, C=.10, D=.20, E=.01, F=.30;
  float curved = ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;
  float white = ((A+C*B+D*E)/(A+B+D*F))-E/F;
  return sat(curved / max(0.000001, white));
}
float toeShoulder(float value) {
  float t=sat(value), toe=clamp(toeKnee,0.0,.5), shoulder=clamp(shoulderKnee,.5,1.0), outValue=t;
  if (toe >= shoulder) return t;
  if (toe > 0.0 && t < toe) { float u=t/toe; outValue=toe*(2.0*u*u-u*u*u); }
  if (shoulder < 1.0 && t > shoulder) { float v=(t-shoulder)/(1.0-shoulder); outValue=(1.0-shoulder)*(-v*v*v+v*v+v)+shoulder; }
  return outValue;
}
float curveAt(float value, int component) {
  float p=sat(value)*4095.0; int low=int(floor(p)); int high=min(4095,low+1); float f=p-float(low);
  vec4 a=texelFetch(curvePixels,ivec2(low,0),0), b=texelFetch(curvePixels,ivec2(high,0),0);
  return mix(a[component],b[component],f);
}
vec3 applyLook(vec3 rgb) {
  if (lookMode == 0 || lookStrength <= 0.0) return rgb;
  vec3 styled;
  if (lookMode == 1) styled=vec3(rgb.r*1.035+rgb.g*.008,rgb.g*1.005,rgb.b*.955+rgb.r*.006);
  else if (lookMode == 2) styled=vec3(rgb.r*1.045-rgb.b*.012,rgb.g*.985+rgb.r*.01,rgb.b*.97+rgb.g*.015);
  else if (lookMode == 3) styled=vec3(rgb.r*.975,rgb.g*1.008,rgb.b*1.035+rgb.g*.008);
  else { float l=dot(rgb,vec3(.2126,.7152,.0722)); float silver=sat((l-.5)*1.08+.5); styled=vec3(silver*1.015,silver,silver*.985); }
  return mix(rgb,styled,sat(lookStrength/100.0));
}
float vignetteFactor(ivec2 coordinate) {
  if (vignette.x == 0.0) return 1.0;
  vec2 normalized=((vec2(coordinate)+.5)/vec2(imageSize)-.5)*2.0;
  float roundness=vignette.z/100.0, exponent=roundness<0.0?2.0+roundness:2.0+roundness*6.0;
  float distanceValue=sat(pow((pow(abs(normalized.x),exponent)+pow(abs(normalized.y),exponent))/2.0,1.0/exponent));
  float midpoint=clamp(vignette.y/100.0,0.0,.999);
  if (distanceValue<=midpoint) return 1.0;
  float falloff=min(1.0,(distanceValue-midpoint)/(1.0-midpoint));
  return 1.0-(vignette.x/100.0)*falloff;
}
float bayer(ivec2 coordinate) {
  const int matrix[64]=int[64](0,48,12,60,3,51,15,63,32,16,44,28,35,19,47,31,8,56,4,52,11,59,7,55,40,24,36,20,43,27,39,23,2,50,14,62,1,49,13,61,34,18,46,30,33,17,45,29,10,58,6,54,9,57,5,53,42,26,38,22,41,25,37,21);
  return (float(matrix[(coordinate.y&7)*8+(coordinate.x&7)])+.5)/64.0;
}
void main() {
  ivec2 coordinate=ivec2(gl_FragCoord.xy);
  vec3 inputRgb=vec3(texelFetch(sourcePixels,coordinate,0).rgb)/65535.0;
  vec3 original=vec3(linearToSrgb(inputRgb.r),linearToSrgb(inputRgb.g),linearToSrgb(inputRgb.b));
  vec3 scene;
  if (densityEnabled) {
    vec3 density=-log(max(vec3(.000001),inputRgb/max(baseLinear,vec3(.000001))))/log(10.0);
    vec3 separated=vec3(dot(separationRow0,density),dot(separationRow1,density),dot(separationRow2,density));
    separated=mix(density,separated,separationAmount);
    float luma=dot(separated,vec3(.2126,.7152,.0722));
    float sharedLow=(densityLow.r+densityLow.g+densityLow.b)/3.0, sharedHigh=(densityHigh.r+densityHigh.g+densityHigh.b)/3.0;
    float tonal=sat((luma-sharedLow)/max(.001,sharedHigh-sharedLow));
    vec3 correction=tonal<.5?mix(correctionShadow,correctionMid,tonal/.5):mix(correctionMid,correctionHighlight,(tonal-.5)/.5);
    scene=max(vec3(0.0),(separated-correction-densityLow)/max(vec3(.001),densityHigh-densityLow));
    if (densityMode==1) scene=vec3(filmic(scene.r),filmic(scene.g),filmic(scene.b));
    else if (toeKnee>0.0||shoulderKnee<1.0) scene=vec3(toeShoulder(scene.r),toeShoulder(scene.g),toeShoulder(scene.b));
  } else scene=inputRgb/lightScales;
  scene*=exposure*gains;
  vec3 rgb;
  if (densityEnabled) rgb=vec3(sat(compressHighlight(max(0.0,scene.r))),sat(compressHighlight(max(0.0,scene.g))),sat(compressHighlight(max(0.0,scene.b))));
  else rgb=vec3(linearToSrgb(compressHighlight(max(0.0,scene.r))),linearToSrgb(compressHighlight(max(0.0,scene.g))),linearToSrgb(compressHighlight(max(0.0,scene.b))));
  rgb=pow(max(vec3(0.0),(rgb-.5)*contrastAmount+.5),vec3(inverseGamma));
  rgb=sat3(rgb+shadowAmount*pow(vec3(1.0)-sat3(rgb),vec3(2.0))+highlightAmount*pow(sat3(rgb),vec3(2.0))+fadeAmount*(vec3(1.0)-rgb));
  float luma=dot(rgb,vec3(.2126,.7152,.0722));
  if (blackAndWhite) rgb=vec3(luma); else { float chroma=max(rgb.r,max(rgb.g,rgb.b))-min(rgb.r,min(rgb.g,rgb.b)); float adaptive=saturationAmount*(1.0+vibranceAmount*(1.0-sat(chroma*1.6))); rgb=sat3(vec3(luma)+(rgb-vec3(luma))*adaptive); }
  rgb=sat3(applyLook(rgb));
  float densityGain=exp2(-cmyDensity.a/100.0);
  rgb=sat3(rgb*(vec3(1.0)-cmyDensity.rgb/100.0)*densityGain);
  rgb=vec3(curveAt(curveAt(rgb.r,0),1),curveAt(curveAt(rgb.g,0),2),curveAt(curveAt(rgb.b,0),3));
  rgb*=vignetteFactor(coordinate);
  if (splitCompare && coordinate.x<imageSize.x/2) rgb=original;
  float threshold=bayer(coordinate);
  rgb=floor(sat3(rgb)*255.0+threshold)/255.0;
  outputColor=vec4(rgb,1.0);
}
`;

const DEFAULT_SEPARATION: Matrix9 = [1.055, -.04, -.015, -.025, 1.05, -.025, -.01, -.035, 1.045];
const LOOKS = ['neutral', 'warm_print', 'classic_color', 'cool_slide', 'silver_bw'] as const;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 GPU shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'GPU shader 编译失败');
  return shader;
}

export class GpuPreviewRenderer {
  private readonly canvas = new OffscreenCanvas(1, 1);
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly sourceTexture: WebGLTexture;
  private readonly curveTexture: WebGLTexture;
  /** BUG-027：顶点缓冲必须随 dispose 释放，此前创建后从未删除。 */
  private readonly vertices: WebGLBuffer;
  private readonly uniformLocations = new Map<string, WebGLUniformLocation>();
  private lastSource?: { input: Uint16Array; width: number; height: number };
  private lastCurveKey = '';

  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    const program = gl.createProgram();
    if (!program) throw new Error('无法创建 GPU program');
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'GPU program 链接失败');
    this.program = program;
    const sourceTexture = gl.createTexture();
    const curveTexture = gl.createTexture();
    if (!sourceTexture || !curveTexture) throw new Error('无法创建 GPU texture');
    this.sourceTexture = sourceTexture;
    this.curveTexture = curveTexture;
    const vertices = gl.createBuffer();
    if (!vertices) throw new Error('无法创建 GPU vertex buffer');
    this.vertices = vertices;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  supports(recipe: EditRecipe, channels: number, hasCubeLut: boolean): boolean {
    return recipe.algorithmVersion === 'chromik-6' && channels === 3 && !recipe.spots?.length && !hasCubeLut
      && !(recipe.density.filmStockProfileId && getMeasuredHdLuts(recipe.density.filmStockProfileId));
  }

  render(input: Uint16Array, width: number, height: number, recipe: EditRecipe, splitCompare = false): Uint8ClampedArray {
    // Refuse the call instead of issuing a WebGL INVALID_OPERATION (which
    // would be silently swallowed and produce a black/garbled frame). Callers
    // are expected to fall back to the CPU path when this throws.
    if (!(input instanceof Uint16Array) || input.length !== width * height * 3) {
      throw new Error('GPU 预览输入尺寸不匹配');
    }
    const gl = this.gl;
    // BUG-027：上下文丢失后立即抛错走 CPU 回退，而不是持续输出黑帧。
    if (gl.isContextLost()) throw new Error('GPU 上下文已丢失，回退 CPU 渲染');
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    if (!this.lastSource || this.lastSource.input !== input || this.lastSource.width !== width || this.lastSource.height !== height) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16UI, width, height, 0, gl.RGB_INTEGER, gl.UNSIGNED_SHORT, input);
      this.lastSource = { input, width, height };
    }
    gl.uniform1i(this.uniform('sourcePixels'), 0);

    const curves = recipe.grade.curves;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    const curveKey = JSON.stringify(curves);
    if (curveKey !== this.lastCurveKey) {
      const curveData = new Float32Array(4096 * 4);
      for (let index = 0; index < 4096; index += 1) {
        const value = index / 4095;
        curveData[index * 4] = evaluateCurve(curves.rgb, value);
        curveData[index * 4 + 1] = evaluateCurve(curves.red, value);
        curveData[index * 4 + 2] = evaluateCurve(curves.green, value);
        curveData[index * 4 + 3] = evaluateCurve(curves.blue, value);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4096, 1, 0, gl.RGBA, gl.FLOAT, curveData);
      this.lastCurveKey = curveKey;
    }
    gl.uniform1i(this.uniform('curvePixels'), 1);

    const density = recipe.density;
    const grade = recipe.grade;
    const stock = density.filmStockProfileId ? getFilmStockProfile(density.filmStockProfileId) : undefined;
    const baseLinear = recipe.baseRgbLinear ?? (recipe.baseRgb?.map((value) => srgbToLinear(value / 255)) as RGB | undefined) ?? [1, 1, 1];
    const light = density.lightSourceRgb?.map((value) => Math.max(1e-6, srgbToLinear(value / 255))) as RGB | undefined;
    const lightLuma = light ? light[0] * .2126 + light[1] * .7152 + light[2] * .0722 : 1;
    const lightScales = light?.map((value) => Math.max(1e-6, value / lightLuma)) as RGB | undefined ?? [1, 1, 1];
    const warmth = grade.temperature / 100, magenta = grade.tint / 100;
    const gains: RGB = [2 ** (warmth*.38+magenta*.08+grade.printerLights[0]/12),2 ** (-magenta*.2+grade.printerLights[1]/12),2 ** (-warmth*.38+magenta*.08+grade.printerLights[2]/12)];
    const matrix = density.separationMatrix ?? DEFAULT_SEPARATION;
    this.i2('imageSize', width, height); this.i1('densityEnabled', density.enabled ? 1 : 0); this.i1('splitCompare', splitCompare ? 1 : 0);
    this.i1('densityMode', density.mode === 'cineon' ? 1 : 0); this.i1('lookMode', Math.max(0, LOOKS.indexOf(grade.look))); this.i1('blackAndWhite', grade.blackAndWhite ? 1 : 0);
    this.v3('baseLinear', baseLinear); this.v3('densityLow', density.low); this.v3('densityHigh', density.high);
    this.v3('correctionShadow', density.shadowCorrection); this.v3('correctionMid', density.midCorrection); this.v3('correctionHighlight', density.highlightCorrection);
    this.v3('separationRow0', matrix.slice(0,3) as RGB); this.v3('separationRow1', matrix.slice(3,6) as RGB); this.v3('separationRow2', matrix.slice(6,9) as RGB);
    this.f1('separationAmount', Math.max(0,Math.min(1,density.separation/100))); this.f1('toeKnee', stock?.toeKnee ?? 0); this.f1('shoulderKnee', stock?.shoulderKnee ?? 1);
    this.v3('lightScales', lightScales); this.f1('exposure', 2 ** grade.exposureEv); this.v3('gains', gains);
    this.f1('contrastAmount', Math.max(.05,1+grade.contrast/100)); this.f1('inverseGamma', 1/Math.max(.2,grade.gamma)); this.f1('saturationAmount', Math.max(0,1+grade.saturation/100));
    this.f1('vibranceAmount', grade.vibrance/100); this.f1('shadowAmount', grade.shadows/100*.24); this.f1('highlightAmount', grade.highlights/100*.2); this.f1('highlightRolloff', grade.highlightRolloff);
    this.f1('fadeAmount', grade.fade/100*.18); this.f1('lookStrength', grade.lookStrength); this.v4('cmyDensity', [grade.cmy.cyan,grade.cmy.magenta,grade.cmy.yellow,grade.cmy.density]);
    this.v3('vignette', [grade.vignette.strength,grade.vignette.midpoint,grade.vignette.roundness]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const output = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU 预览读取失败');
    return output;
  }

  private uniform(name: string) {
    const cached = this.uniformLocations.get(name);
    if (cached) return cached;
    const value=this.gl.getUniformLocation(this.program,name);
    if (!value) throw new Error(`GPU uniform 缺失：${name}`);
    this.uniformLocations.set(name, value);
    return value;
  }

  /** Release GPU resources. Safe to call once; subsequent calls are no-ops. */
  dispose(): void {
    try { this.gl.deleteTexture(this.sourceTexture); } catch { /* already lost */ }
    try { this.gl.deleteTexture(this.curveTexture); } catch { /* already lost */ }
    try { this.gl.deleteBuffer(this.vertices); } catch { /* already lost */ }
    try { this.gl.deleteProgram(this.program); } catch { /* already lost */ }
    // The OffscreenCanvas is closed implicitly when the surrounding worker
    // is torn down; we cannot force it here without vendor-specific paths.
  }
  private tryUniform(name: string) {
    const cached = this.uniformLocations.get(name);
    if (cached) return cached;
    const value=this.gl.getUniformLocation(this.program,name);
    if (!value) return null;
    this.uniformLocations.set(name, value);
    return value;
  }
  private f1(name:string,value:number){this.gl.uniform1f(this.uniform(name),value);} private i1(name:string,value:number){this.gl.uniform1i(this.uniform(name),value);}
  private i2(name:string,a:number,b:number){this.gl.uniform2i(this.uniform(name),a,b);} private v3(name:string,value:ArrayLike<number>){this.gl.uniform3f(this.uniform(name),value[0],value[1],value[2]);}
  private v4(name:string,value:ArrayLike<number>){this.gl.uniform4f(this.uniform(name),value[0],value[1],value[2],value[3]);}
}
