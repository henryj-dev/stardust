---
"stardust": patch
---

A Worker release's log shows on its run page: the log reader reads the pod's main container when it has no build container (a release's is `deploy`), and a running or failed init step before it starts. Before, the page asked again forever with "the build has not started printing yet".
