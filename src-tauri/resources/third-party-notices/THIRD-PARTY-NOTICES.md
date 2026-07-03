# Third-Party Notices

This application bundles the following third-party software.

## ffmpeg

VPS bundles a static `ffmpeg` executable, invoked as a separate subprocess
by the Python sidecar (it is not statically or dynamically linked into any
compiled binary in this application).

- Project: https://ffmpeg.org
- License: GNU Lesser General Public License v2.1 or later (LGPL). See
  `ffmpeg-LICENSE.txt` alongside this file, or
  https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- Windows build source: https://github.com/BtbN/FFmpeg-Builds
- macOS build source: https://evermeet.cx/ffmpeg/

## Demucs pretrained model weights

VPS bundles pretrained weights for the `htdemucs` model from the Demucs
project (Meta Platforms, Inc.).

- Project: https://github.com/facebookresearch/demucs
- License: MIT (code); weights distributed under the same repository terms
- Source: https://dl.fbaipublicfiles.com/demucs/
