# Seven Processing sketches join the empty-pane animations

Status: raised for v0.108.0 by the owner's word of 2026-10-20 (the seven posts below, "the old ones i dont want"), replacing the two Yohei Nishitsuji shaders first asked the same day; owner the frontend seat. The owner sees each animation on a test server before the row ships.

## What is asked

Add seven animations to the empty-pane catalog, adapted from these `#つぶやきProcessing` posts. Sources as read from each post's public embed on 2026-10-20 (HTML entities decoded, media link removed); the raw reads are in the gitignored `dev/roadmap-prep/animations/` (`<id>.json`, `<id>.src`).

1. Koma Tebe, 2022-12-05, https://x.com/KomaTebe/status/1599750436910686208 (p5.js, WEBGL): a lit plate with stacked boxes and tori, rotating.

```js
f=0,draw=o=>{for(f||createCanvas(W=400,W,WEBGL,X=rotateX),background(0),stroke(W,120),X(3),rotateY(f/66),fill(W,99),lights(),box(p=150,1,p),i=0;i<p;i+=10)push(),box(x=i+f%10,300-2*x,x),X(PI/2),rotate(PI/4),stroke(W,(p-i)/3),pop(torus(2*x+99,1,4,2));f+=.3};
```

2. Koma Tebe, 2023-03-24, https://x.com/KomaTebe/status/1639375802964795392 (p5.js, WEBGL): a shell of about 16,000 small spheres, unlit.

```js
f=0,draw=a=>{for(f||createCanvas(W=400,W,WEBGL,R=rotateY),background(0),j=0;j<PI;j+=PI/128)for(i=0;i<TAU;i+=PI/64)push(R(j)),R(f),translate(sin(T=tan(atan(i+j)))*(S=sin(J=j+f)*W),atan(cos(J))*sin(J)*W,cos(T)*S),R(i),pop(sphere(2*sin(J*PI*f),W));f+=PI/2048};
```

3. Hau_kun, 2020-06-18, https://x.com/Hau_kun/status/1273643037747318785 (Processing, 2D): six recursive swaying branches of lines.

```java
float t,r;
void setup(){size(720,720);stroke(-1);}
void draw(){
clear();
t+=.01;
for(r=0;r<6;r++)
f(360,360,PI/3*r,99);
}
void f(float x,float y,float r,float d){if(d>5){line(x,y,x+=cos(r)*d,y+=sin(r)*d);f(x,y,cos(t)+r+PI/2,d*.7);f(x,y,sin(t)+r-PI/7,d*.72);}}
```

4. Koma Tebe, 2022-09-21, https://x.com/KomaTebe/status/1572556353733906432 (p5.js, WEBGL): a ring of 64 tori lit by an orbiting point light, with a small sphere marking the light.

```js
function draw(){for(f||createCanvas(W=400,W,WEBGL,T=translate),T(60*sin(f),-20,z=170),push(f+=.01),T(X=99*sin(-f),0,Z=99*cos(f)),pop(sphere(4,W)),pointLight([W],X,0,z+Z),i=0;i<TAU;i+=PI/32)push(),rotateY(i+f),T(120,0),rotateX(.8),pop(torus(80,4,W))}f=0;
```

5. yuruyurau, 2020-07-14, https://x.com/yuruyurau/status/1283102963112636416 (Processing Python mode, P3D): a bitwise dot pattern drawn each frame, captured with `get()` and used as the texture of six nested spheres (`createShape(40, r)`, 40 being `SPHERE`).

```python
N=256
def setup():size(N*2,N*2,P3D);noStroke()
def draw():clear();translate(N,N);[2*i%N&(i/N*2+frameCount)or circle(i%N*2-N,i/N*2-N,3)for i in range(N*N)];rotateX(2);e=get();clear();[s.setTexture(e)or shape(s)for s in[createShape(40,-~i*30)for i in range(6)]]
```

6. hisadan, 2024-06-20, https://x.com/hisadan/status/1803807190039384154 (Processing, 2D): a spiral of circles that contracts and fades.

```java
float t=5,r;
void setup(){size(800,800);}
void draw(){
background(0);noFill();
stroke(-1,t*99);
for(r=0;r<TAU*99;r+=PI/2.6)circle(r*t*sin(r)+400,r*t*cos(r)+400,r);
t/=1.002;}
```

7. Koma Tebe, 2023-03-02, https://x.com/KomaTebe/status/1631278190244265991 (p5.js, WEBGL): about 12,000 spheres on a rotating spherical shell, sized by `tan(u+v)/6`.

```js
f=0,draw=s=>{for(f||createCanvas(W=400,W,WEBGL),background(0),rotateX(f),u=0;u<3*TAU;u+=PI/32)for(U=u+f/99,v=PI;v>PI/64;v-=PI/64)V=v-f%(PI/1024),r=220*sin(v+f),push(),translate(sin(U)*sin(V)*r,cos(V)*r,cos(U)*sin(V)*r),sphere(tan(u+v)/6,W),pop();f+=PI/256};
```

## What is there

The catalog is `EMPTY_PANE_ANIMATIONS` in `web/packages/workspace-app/src/components/emptyPaneAnimations.ts` (thirty-three entries, eleven `2d` and twenty-two `webgl2`), each a logic module, a Svelte wrapper registered in `EmptyPaneWelcome.svelte`, tunables in `animation-tuner/tunables.ts`, and a credits entry in `web/packages/marketing/src/animation-credits.json`. None of the seven is in the catalog (their status ids are absent from the credits file). The same authors are already ported: Koma Tebe's Chaotic Halo (`2d`) and Drifting Galaxy (`webgl2`, grains as round points, `driftingGalaxy.ts`, "Geometry and motion adapted from Koma Tebe's p5.js sketch"), Hau_kun's Recursive Arc Bloom, Branching Wreath and Ninefold Lotus, and seven yuruyurau ports. The Tenfold Dahlia commit `ab97ad1b0`, its follow-ups `d3b18d612` and `97095ec98`, and the credits commit `c2231097e` are the steps of one addition. `../chan-dev/releases/anim-shots-v090/` holds an earlier round's animation screenshots.

## What is new here

- Sketches 1 and 4 draw lit meshes (`box`, `torus`, `sphere` with `lights()` or a `pointLight`). No catalog entry draws a lit mesh today; a small mesh and diffuse-light path in WebGL2 is new code, shared by the two.
- Sketches 2 and 7 draw thousands of tiny unlit spheres; round points (`roundPoints.ts`, as Drifting Galaxy does) are the likely port, a choice to show the owner against true spheres.
- Sketch 5 renders its dot pattern to a texture each frame; computing the pattern in the sphere's fragment shader avoids the readback.
- Sketch 6 is finite: `t/=1.002` per frame takes the stroke alpha (`t*99`) below one step after about 3,100 frames, some fifty seconds at 60 frames a second, after which the canvas is black. The port needs a loop (restart, or a back-and-forth on `t`); the owner chooses.
- Sketch 7's `tan(u+v)/6` gives sizes that pass through zero and grow without bound near the poles of `tan`; p5 draws a negative radius as nothing. The port clamps; the owner judges the look.
- Sketches 1 and 7 keep p5's default stroke in WEBGL mode (edges drawn over the fill); whether the port keeps edges is a fidelity choice.
- Sketches 3 and 6 are 2D and fit the `2d` runner, which the masked-renderer rule keeps on machines without a GPU.

## What to do

Per animation, the `ab97ad1b0` steps: logic module with the attribution comment and post URL beside the source kept verbatim in a constant, its own test, a Svelte wrapper, the welcome map entry, the catalog entry with its runner, tunables for every theme, the credits entry in catalog order, the id-list and last-pick pins, a row on the frame-rate page `scripts/e2e/animation-fps/main.ts`. Names and descriptions proposed by the build and chosen by the owner on the test server. One commit per animation, plus one for the shared mesh path.

## Test server

Per `.agents/skills/test-server/SKILL.md`, a server from the build's branch on which the owner can pick each new animation (the welcome's step control and the `/animations/` page), in light and dark themes. The owner's word on each is recorded here; an animation the owner rejects is dropped from the branch, not shipped.

## Boundaries

`web/packages/workspace-app/src/components/` (the new modules, wrappers and the shared mesh path, the catalog, the welcome map), `animation-tuner/tunables.ts`, `web/packages/marketing/src/animation-credits.json`, the frame-rate page, their tests. Not changed: the masked-renderer rule and the existing animations.

## Acceptance

1. Each source kept byte for byte in its module beside the post URL; a test reads each constant against the source above.
2. `make web-check` green with the updated pins; the credits test green.
3. A frame-rate reading of each new animation on the harness, with the engine named, beside the existing rows; a WebGL entry far above the existing WebGL rows is reported to the owner, bearing on the row about WebGL on a machine without a GPU ([wglgrd](the-desktop-welcomes-webgl-animations-burn-the-cpu-on-a-machine-without-a-gpu.md)).
4. The owner's verdict on each animation from the test server recorded here, with the fidelity choices above (points or spheres, edges, sketch 6's loop, sketch 7's clamp) in their words.
