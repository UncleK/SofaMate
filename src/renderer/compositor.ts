import type { MediaProfile } from '../core/types';
export class Compositor {
  readonly gl: WebGLRenderingContext;
  private texture: WebGLTexture;
  private program: WebGLProgram;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL unavailable: transparent composition cannot run');
    this.gl = gl;
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? 'Shader failed');
      return s;
    };
    const vertex = compile(
      gl.VERTEX_SHADER,
      'attribute vec2 pos; varying vec2 uv; void main(){uv=vec2((pos.x+1.0)*0.5,(1.0-pos.y)*0.5);gl_Position=vec4(pos,0.0,1.0);}',
    );
    const fragment = compile(
      gl.FRAGMENT_SHADER,
      `precision highp float; varying vec2 uv; uniform sampler2D media; uniform float isPacked; uniform vec2 texSize;
      void main(){vec2 halfPixel=0.5/texSize;vec2 p=clamp(uv,halfPixel,1.0-halfPixel);if(isPacked>0.5){vec2 colorUV=vec2(clamp(uv.x*0.5,halfPixel.x,0.5-halfPixel.x),p.y);vec2 alphaUV=vec2(clamp(0.5+uv.x*0.5,0.5+halfPixel.x,1.0-halfPixel.x),p.y);vec3 rgb=texture2D(media,colorUV).rgb;float a=texture2D(media,alphaUV).r;gl_FragColor=vec4(rgb*a,a);}else{vec4 c=texture2D(media,p);gl_FragColor=vec4(c.rgb*c.a,c.a);}}`,
    );
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Shader link failed');
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.useProgram(this.program);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, 'pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  draw(source: HTMLVideoElement | HTMLImageElement, profile: MediaProfile) {
    const gl = this.gl;
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth,
      height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
    if (!width || !height) throw new Error('No decoded frame');
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1f(gl.getUniformLocation(this.program, 'isPacked'), profile === 'packed-rgb-alpha' ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'texSize'), width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  clear() {
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
  dispose() {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
