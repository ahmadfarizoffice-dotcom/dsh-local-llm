# Third-party notices

This plugin **does not bundle** third-party binaries or model files. It downloads
them at the user's request, from the projects that publish them:

| Component | Source | Licence |
| --- | --- | --- |
| `llama-server` (llama.cpp) | https://github.com/ggml-org/llama.cpp releases | MIT |
| Model files (`.gguf`) | Hugging Face repositories chosen by the user | whatever each model repository states |

Model weights carry their own licences — check the model card on Hugging Face
before redistributing or using a model commercially. The MIT licence in
`LICENSE` covers this plugin's own source.
