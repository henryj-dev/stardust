{{- define "stardust.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "stardust.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* selectorLabels <root> <component> */}}
{{- define "stardust.selectorLabels" -}}
app.kubernetes.io/name: {{ (index . 0).Chart.Name }}
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* image <root> <component>: digest wins over tag; tag defaults to appVersion. */}}
{{- define "stardust.image" -}}
{{- $root := index . 0 -}}
{{- $c := index $root.Values.image (index . 1) -}}
{{- $repo := printf "%s/%s" $root.Values.image.registry $c.repository -}}
{{- if $c.digest -}}
{{- printf "%s@%s" $repo $c.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default $root.Chart.AppVersion $c.tag) -}}
{{- end -}}
{{- end -}}

{{- define "stardust.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "stardust.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "stardust.databaseSecret" -}}
{{- required "database.existingSecret is required: name of a Secret holding the PostgreSQL URL" .Values.database.existingSecret -}}
{{- end -}}

{{/* Shared pod spec fields. */}}
{{- define "stardust.podCommon" -}}
serviceAccountName: {{ include "stardust.serviceAccountName" . }}
automountServiceAccountToken: false
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Environment and mounts for processes that read stardust.yaml. */}}
{{- define "stardust.configEnv" -}}
- name: STARDUST_CONFIG
  value: /etc/stardust/stardust.yaml
- name: STARDUST_VERSION
  value: {{ .Chart.AppVersion | quote }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "stardust.databaseSecret" . }}
      key: {{ .Values.database.key }}
{{- end -}}
