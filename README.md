# MyEditor

Editor de vídeo local (Vite + React + TypeScript) con un servidor Node pequeño que llama a FFmpeg.
Sin nube ni cuentas: todo se queda en `workspace/` dentro de esta carpeta.

## Arrancar

Requisitos: Node 20+ y `ffmpeg`/`ffprobe` en el PATH (o `MYEDITOR_FFMPEG` / `MYEDITOR_FFPROBE`).

```bash
npm install
npm run dev
```

Abre http://localhost:5174. El servidor escucha solo en `127.0.0.1:5175`.

- `npm run smoke`: prueba de extremo a extremo con clips generados (`testsrc` + tono). Usa un workspace temporal y lo borra al terminar.
- `npm run typecheck`: comprobación de tipos.

## Qué hace

1. **Medios:** importar arrastrando a la ventana, a la biblioteca o a una pista. Cada medio se puede eliminar con la papelera de la biblioteca (pide confirmación si se usa en el timeline y se deshace con ⌘Z).
2. **Pistas:**
   - **Principal** (magnética): al insertar, borrar, mover o recortar un clip, los siguientes se desplazan para no dejar huecos.
   - **Secundarias** (vídeo encima de la principal, audio debajo): edición libre, sin desplazar nada. Si un clip se solaparía con otro, va a una pista nueva. Las pistas vacías desaparecen solas.
3. **Arrastrar clips** dentro del timeline: reordenar e intercalar en la principal, colocar libremente en las secundarias, llevar un vídeo entre la principal y una pista superpuesta, o un audio entre pistas de audio. Las franjas superior e inferior crean una pista nueva.
4. **Ajuste magnético** (botón «Ajuste» o **N**): clips, bordes recortados y cabezal encajan con los bordes de otros clips, el cabezal, las marcas I/O y el 0. Sin él, el movimiento es libre (solo se redondea al fotograma).
5. Cortar en el cabezal (**S**), borrar (**⌫**), recortar arrastrando los bordes. Clic derecho en un clip abre un menú con más acciones.
6. **Separar audio** (**⇧A**): queda enlazado a su vídeo (lo sigue al moverlo, cortarlo o recortarlo). Puede cambiar de pista de audio o **desenlazarse** para moverlo libremente.
7. **Edición de audio** en el panel derecho, en una sección rotulada: volumen en **%** (100 % = nivel original, hasta 400 %) y fundidos de entrada y salida en **segundos**, con sliders y campos numéricos sincronizados (Enter aplica, Esc cancela, ↑/↓ ajustan).
8. Transición **Mix** (fundido cruzado) en la pista principal, con duración ajustable.
9. Exportar a MP4 H.264 + AAC en 1080p o 4K: todo el proyecto o el tramo marcado con **I** y **O**. Las pistas de vídeo superiores se componen encima de la principal.
10. **Asociación con la pista principal:** cada clip de otra pista pertenece al clip principal con el que más se solapa, aunque empiece antes. Si no toca ninguno, es independiente.
    - **Mover** un clip principal arrastra sus asociados manteniendo su posición relativa.
    - **Cambiar la duración** (recortar, Mix) deja quietos sus propios asociados y desplaza los de los clips siguientes.
    - Las pistas bloqueadas nunca se desplazan.
11. **Selección múltiple:** rectángulo arrastrando en un hueco del timeline (abarca varias pistas y resalta en vivo), Shift o ⌘/Ctrl + clic para añadir o quitar, ⌘A para seleccionar todo. La selección se mueve, se borra, se agrupa o se convierte en composición.
12. **Agrupar** (⌘G) / **Desagrupar** (⇧⌘G): los clips siguen en sus pistas, pero se seleccionan y se mueven juntos.
13. **Composición** (⌥⌘G): encierra la selección en un solo clip.
    - Doble clic la abre para editar su timeline interno; los cambios se ven fuera y Esc vuelve.
    - **Descomponer** devuelve los clips originales.
    - Si incluye clips de la pista principal, ocupa exactamente su tramo (nada más se mueve). Lo que sobresale queda oculto dentro y se recupera alargándola o descomponiéndola.
14. **Controles por pista:** candado (bloquear), ojo (ocultar en vista previa y exportación, solo en pistas de vídeo) y altavoz (silenciar sin tocar el volumen de los clips). Se pueden deshacer.
15. Guardar y abrir el proyecto como JSON (**⌘S** / **⌘O**). Los proyectos de versiones anteriores (v1, v2) se abren y se migran solos.
16. **Panel de edición en dos pestañas:**
    - **Vídeo:** posición horizontal y vertical, escala (10–500 %) y recorte de cada borde, con sliders y campos en %, más las Mejoras Pro de imagen. El clip también se mueve arrastrándolo en la vista previa y se escala desde sus esquinas; el centro se ajusta solo a las guías (Alt lo evita). Recortar oculta bordes sin mover la imagen, y debajo se ven las otras pistas. Si una composición está transformada, lo está todo su contenido, y al descomponerla cada clip conserva esa transformación.
    - **Audio:** volumen, fundidos, separar o desenlazar el audio y las Mejoras Pro de sonido.
17. **Paneles laterales con ancho ajustable:** arrastra el borde de Medios o del panel de edición. Doble clic restablece el ancho, las flechas lo ajustan y la app recuerda los anchos.
18. **Mejoras Pro:** ver abajo.

## Mejoras Pro

Mejoras con herramientas libres que corren en este Mac.

Instalación (una vez, ~1 GB de modelos y ~3 GB de paquetes):

```bash
npm run pro:setup
```

`pro/setup.sh` crea `pro/.venv` con Python 3.11 e instala `resemble-enhance` con `--no-deps` más sus dependencias reales y GFPGAN. Después `pro/prepare.py` corrige dos incompatibilidades y baja los modelos a `pro/models/`:
- `resemble_enhance/enhancer/lcfm/cfm.py`: `fsolve(...)` → `fsolve(...)[0]`.
- `basicsr/data/degradations.py`: `functional_tensor` → `functional`.

Por último, `pro/check.py` carga los dos modelos en la GPU (MPS, CUDA o CPU), mide su velocidad con datos sintéticos y guarda el resultado en `pro/models/status.json`. `deepspeed` (solo se usa para entrenar) se sustituye por un módulo vacío en `sys.modules`.

En la GPU de los Mac (MPS), el vocoder de Resemble Enhance da un audio erróneo con esta versión de PyTorch: casi silencio y pitidos fijos en 44100/3, /6 y /12 Hz, mientras el resto del modelo coincide con la CPU. Por eso solo el vocoder corre en la CPU y lo pesado sigue en la GPU (`pro/common.py`). `check.py` comprueba con una voz sintética que el resultado conserve el nivel y deje el silencio en silencio, y avisa si falla.

Están repartidas entre las pestañas Vídeo (imagen) y Audio (sonido). Cada casilla se aplica al tramo del clip seleccionado y crea una copia mejorada; el clip pasa a usarla y ⌘Z o «Volver al original» lo deshacen. El trabajo corre en segundo plano, con barra de progreso y tiempo restante, y al terminar se abre el comparador **ANTES | DESPUÉS**. En el comparador, A y D eligen qué lado se oye.

| Mejora | Herramienta | Receta |
|---|---|---|
| Quitar parpadeo y ruido de imagen | FFmpeg | `deflicker=size=5:mode=am,hqdn3d=1.4:1.2:4:4` |
| Mejorar calidad del rostro | GFPGAN v1.4 (`pro/face.py`) | `upscale=1`, `arch=clean`, `channel_multiplier=2`, `weight=0.4`, `only_center_face`. Mezcla 60 % restaurado y 40 % original, y después `hqdn3d=0:0:6:6,eq=brightness=0.03:contrast=1.02:saturation=1.12,colorchannelmixer=rr=0.995:bb=1.005` |
| Mejorar voz | Resemble Enhance (`pro/voice.py`) + FFmpeg | La receta aprobada de `mejorar_voz.py`: entrada mono a 48 kHz, `nfe=128`, `midpoint`, `lambd=0.9`, `tau=0.1`, intermedio de 16 bits y después `highpass=f=75`, tres `equalizer` en 14492/14702/14912 Hz (−15/−20/−15 dB) para el tono fijo que deja el modelo, `equalizer=f=1600`, `highshelf=f=3500`, `lowpass=f=15500` ×2, `acompressor` y `alimiter`. Otro tono fijo solo se quita si sobresale 15 dB o más |
| Normalizar volumen | FFmpeg | `pan=stereo\|c0=c0\|c1=c0,loudnorm=I=-18:TP=-1.5:LRA=7`, en una pasada como en la receta. Con «Mejorar voz» marcada, las dos forman exactamente la cadena aprobada |

**Si una palabra suena mal** (la IA tiene algo de azar, como en `mejorar_voz.py`):
- **Varias pasadas:** con «Mejorar voz» marcada, elige 1, 3 o 5 pasadas. Cada una sale distinta; se mide cuánto se parece cada una al original entre 100 Hz y 4 kHz (como `fidelidad.py`) y se queda la más fiel. Tarda proporcionalmente más.
- **Arreglar una palabra** (pestaña Audio o comparador): cada mejora de voz guarda en `workspace/pro-kits/` la pasada elegida y la versión de **solo limpieza** de Resemble (`denoise`, natural, sin agudos reconstruidos). Marca el tramo de la palabra, a mano o desde «Momentos que más cambiaron» (los marcados en rojo están 1,6 veces o más por encima de lo normal), y elige cuánto de la versión natural usar. Igual que `palabra.py`, se iguala su volumen y entra con fundidos de 60 ms; después se repite la misma cadena de FFmpeg. Se rehace en segundos, sin volver a pasar la IA, y ⌘Z lo deshace.

Al terminar se miden el volumen (LUFS, pico real y rango), el parpadeo (cambio medio de brillo por cuadro), los cuadros con rostro y los pitidos quitados, y todo se muestra en el comparador.

Para ajustar la receta a otra voz o cámara, compara esas medidas antes y después. Las constantes están en `server/pro.ts` y en `pro/face.py`.

El tiempo estimado parte de las medidas de `check.py` (o de 0,34 s por cuadro para la cara en un M1 Max) y se ajusta solo con cada trabajo real (`pro/models/timings.json`).

## Formato del proyecto

`*.myeditor.json`. Los tiempos van en microsegundos enteros y los medios se identifican por un hash de su contenido. Si al abrir falta un medio, se vuelve a enlazar solo al arrastrar otra vez el archivo original.

```json
{
  "schema_version": 3, "app": "MyEditor", "time_unit": "us", "fps": { "num": 30, "den": 1 },
  "media": { "<hash>": { "name": "clip.mp4", "duration_us": 10000000, "has_video": true, "has_audio": true } },
  "tracks": [
    { "id": "main", "kind": "video", "main": true, "clips": [{ "media": "<hash>", "source": { "start_us": 0, "duration_us": 4000000 },
      "timeline_start_us": 0, "gain_db": 0, "fade_in_us": 0, "fade_out_us": 0,
      "audio_detached": true, "transition_out": { "type": "mix", "duration_us": 500000 } }] },
    { "id": "<uuid>", "kind": "audio", "clips": [{ "media": "<hash>", "linked_to": "<id del clip de vídeo>", "...": "..." }] }
  ],
  "range": { "in_us": 2000000, "out_us": 7000000 }
}
```

## De la edición a FFmpeg (`shared/exportGraph.ts`)

| Acción | FFmpeg |
|---|---|
| Aplanado (`shared/flatten.ts`) | Pistas, composiciones anidadas, pistas ocultas y silenciadas se convierten en capas y sonidos; lo usan la vista previa y la exportación |
| Corte / recorte | Una entrada por pieza con `-ss`/`-t` y `setpts=PTS-STARTPTS` |
| Capas | fondo `color=black` + `overlay=enable='between(t,…)'` por pieza, de abajo arriba |
| Mix | la pieza entrante aparece con `fade=t=in:alpha=1` sobre la saliente |
| Audio en el Mix | `afade` de salida y de entrada que se solapan (fundido cruzado) |
| Volumen y fundidos | `volume=XdB`, `afade=t=in` / `afade=t=out` |
| Colocar el audio | `adelay` + `amix` sobre una pista de silencio tan larga como el proyecto |
| Pistas de vídeo superiores | `setpts=PTS+inicio/TB` + `overlay=enable='between(t,…)'` |
| Tramo I/O | `trim` / `atrim` al final |
| 1080p / 4K | `scale` + `pad` (bandas negras si el formato no es 16:9), `h264_videotoolbox` (si falla, `libx264`), AAC 192k |
