# Seven Processing sketches join the empty-pane animations

Status: built on 2026-10-21 on the seat's branch `v0108/sketch` and landed on `main` the same day by the merge `82ec17a9f`, the owner having accepted the final previews; it closes at the GA as shipped.

Record before the landing: implemented and owner-approved for v0.108.0 on `v0108/sketch` (2026-10-21); ready for merge.

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

## Owner review, 2026-10-21

- Names and descriptions for sketches 3, 6, 2 and 7: "Use all four recommended names and descriptions." The selected pairs are Swaying Branches / "Six recursive branches sway and fold around the center.", Contracting Spiral / "A spiral of outlined circles contracts and fades before returning.", Turning Shell / "Fine grains turn through a rippling spherical shell.", and Tangent Shell / "A rotating shell breathes through bands of large and small grains."
- Sketches 2 and 7: "Keep round points for both (recommended): matches the small unlit silhouettes with less rendering work."
- Sketch 7's radius cap: "4 pixels (recommended): visible bead bands without dominating the shell."
- Sketch 6's initial selection, superseded: "Restart (recommended): preserve the original contraction, then restart after it fades."
- Sketch 6's bounce decision: "the contracting spiral needs to bounce.. like it's looping but it goes all the way to the end and does the opposite move". The initial bounce preview contracted to the source's one-alpha-step end, then retraced the motion in reverse and repeated; the cutoff is shortened by the tuning below.

## Source observations

The historical p5.js 1.5.0 implementation contradicts two statements above: sphere detailX 400 suppresses strokes, and negative radii are passed through as signed mesh scales. A Chrome pixel check of sphere(30, 400), sphere(-30, 400) and sphere(0, 400) painted 3,134, 3,134 and zero pixels respectively. The unlit point ports therefore use the radius magnitude; sketch 7 has no source edge overlay to preserve. Evidence: p5.js v1.5.0 src/webgl/3d_primitives.js and the branch's dev/p5-radius-check.json. The source loops also include boundary samples through floating-point accumulation: 16,641 spheres for sketch 2 and 12,352 for sketch 7. Sketch 2's rotateY(j) executes before push(), so its rotation accumulates across grains; the port retains this order.

## Owner tuning, 2026-10-21

Swaying Branches: "use:"

```css
--swaying-branches-field-scale: 1.05;
--swaying-branches-tone: 0.68;
--swaying-branches-opacity: 0.32;
```

"and slow down the default tempo by half for swaying branches". Applied to the dark/default palette, with field scale 1.05 shared by both themes and the default clock reduced from 0.6 to 0.3 radians per second.

Turning Shell: "use:"

```css
--turning-shell-field-scale: 0.65;
--turning-shell-tone: 0.61;
--turning-shell-opacity: 0.465;
```

"and slow by 1/3 by default". Applied to the dark/default palette, with field scale 0.65 shared by both themes. Interpreted as reducing the current tempo by one third, from 60 to 40 source frames per second; stated to the owner when applying it.

Tangent Shell: "same for:"

```css
--tangent-shell-field-scale: 0.95;
--tangent-shell-tone: 0.495;
--tangent-shell-opacity: 0.68;
--tangent-shell-max-radius: 6;
```

"and 1/3 of the speed by default". Applied to the dark/default palette, with field scale 0.95 and radius cap 6 shared by both themes. The clock advances at 20 source frames per second. This supersedes the earlier 4-pixel cap.

Bitwise Spheres: "sure bitwise spheres". Selected name: Bitwise Spheres; proposed description: "Six nested spheres carry a changing pattern of binary dots."

Tuner access: "i want to be able to configure all of them". All seven expose field scale, tone and opacity in the tuner, with Tangent Shell's radius cap and Stacked Spire's edges. The stage's up/down keys adjust playback speed. Torus Lantern's initial trails control was removed at the owner's subsequent request below.

Contracting Spiral: "the contracting spiral animation is doing the right thing now, but we need to cut off 1/3 of the cycle from the current end part, and recycle there". Reverse after two thirds of the previous inward leg, preserving the contraction rate and symmetric return. The complete cycle is approximately 69 seconds instead of 103.5 seconds at the default tempo.

Torus Lantern: "we need:"

```css
--torus-lantern-field-scale: 1.3;
--torus-lantern-tone: 0.48;
--torus-lantern-opacity: 0.575;
--torus-lantern-trails: 0;
```

"and half the time for the torus-lantern". Applied to the dark/default palette, with field scale 1.3 in both themes. Interpreted as half playback speed, from 0.6 to 0.3 radians per second, and stated to the owner when applying it.

Torus Lantern trails: "we dont need the trails parameter, it doesn't work when set to 1". Removed the parameter from the component and tuner. Every frame clears the color and depth buffers; the source's retained trails are deliberately omitted. This supersedes the earlier trails comparison control.

Bitwise Spheres final tuning: "done with these:"

```css
--bitwise-spheres-field-scale: 1.2;
--bitwise-spheres-tone: 0.52;
--bitwise-spheres-opacity: 0.295;
```

"and half of the speed". Applied to the dark/default palette, with field scale 1.2 in both themes and the clock reduced from 60 to 30 source frames per second. The owner's "done with these" is the visual verdict for Bitwise Spheres with these settings.

Further speed tuning: "need to slow down:"

- "stacked spire by half speed"
- "torus lantern by half speed"

Halved both current defaults, as stated to the owner. Stacked Spire now advances at 9 source units per second (half its original 18); Torus Lantern advances at 0.15 radians per second (one quarter of its original 0.6).

Contracting Spiral final turnaround: "about contracting spiral: in today's speed, it should bounce back on the ~20s mark". It reverses at 20 seconds of default playback, then returns symmetrically for a full 40-second cycle. This supersedes the two-thirds cutoff while preserving the contraction rate.

## Owner final verdict, 2026-10-21

"im ready to commit all these and close off our session here". Accepted all seven current previews and their recorded final tuning for commit. This closes the remaining label/description and Stacked Spire edge choices: keep Stacked Spire / "A rotating stack of lit boxes rises through thin diamond rings." with edges, and Torus Lantern / "A ring of tori catches an orbiting light." without trails. Bitwise Spheres uses "Six nested spheres carry a changing pattern of binary dots."

## Final frame-rate reading

The final settings were measured with the existing frame-rate instrument in HeadlessChrome/150.0.0.0 at DPR 1 on a 900x560 stage. The instrument reported `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` and returned INCONCLUSIVE (code 2), so these observer frame rates are software-renderer evidence, not hardware acceptance. Torus Lantern's 40.1 fps was reported to the owner; its source mesh detail remains unchanged. The full raw result is in the branch's `dev/frame-rate-final-tuning.json`.

| Animation | Observer fps | p95 ms |
| --- | ---: | ---: |
| baseline (nothing mounted) | 60.2 | 16.7 |
| Sixfold Vortex | 60.2 | 16.7 |
| Hexagonal Bloom | 60.0 | 16.8 |
| Fourteenfold Bloom | 60.0 | 16.8 |
| Lorenz Constellation | 60.0 | 16.8 |
| Rippled Duet | 60.1 | 16.7 |
| Striated Current | 60.1 | 16.7 |
| Twin Veil Dance | 60.1 | 16.7 |
| Polar Drift | 60.1 | 16.7 |
| Turbulent Oculus | 5.2 | 233.3 |
| Amber Recursion | 17.2 | 66.7 |
| Stellar Outburst | 8.1 | 133.4 |
| Tenfold Dahlia | 14.2 | 83.4 |
| Cosmic Bell | 60.2 | 16.8 |
| Segmented Torus | 60.0 | 16.8 |
| Swaying Branches | 60.1 | 16.7 |
| Contracting Spiral | 60.0 | 16.7 |
| Turning Shell | 60.0 | 16.8 |
| Tangent Shell | 60.1 | 16.7 |
| Stacked Spire | 60.1 | 16.7 |
| Torus Lantern | 40.1 | 33.4 |
| Bitwise Spheres | 60.0 | 16.7 |

## Validation and handoff

The final committed implementation passed `make web-check`: 218 web-shared tests, 619 launcher tests, 7,296 workspace-app tests and 20 profile tests, with all type checks and production builds green. The credits suite passed its 2 tests. Chrome verified nonblank motion in both themes, working live tuner controls for all seven and a spiral reversal at 19.9 seconds; all seven source constants independently matched the code blocks above. Regression checks were shown failing against the old cutoff, trail behavior and clocks before passing with the final implementation.

The branch has one commit per animation plus a shared-mesh commit. The merge handoff, per-commit paths, logs, screenshots and proposed CHANGELOG entry are in `dev/handoff.md`. The isolated preview server was stopped and its empty throwaway workspace unregistered after owner acceptance. Nothing was pushed or merged; hardware GPU performance remains unverified.
