{{/*
Expand the name of the chart.
*/}}
{{- define "agentkitmarket.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agentkitmarket.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agentkitmarket.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels — API
*/}}
{{- define "agentkitmarket.selectorLabelsApi" -}}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: api
{{- end }}

{{/*
Selector labels — worker
*/}}
{{- define "agentkitmarket.selectorLabelsWorker" -}}
app.kubernetes.io/name: {{ include "agentkitmarket.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end }}

{{/*
ConfigMap name
*/}}
{{- define "agentkitmarket.configmapName" -}}
{{ include "agentkitmarket.fullname" . }}-config
{{- end }}

{{/*
Secret name
*/}}
{{- define "agentkitmarket.secretName" -}}
{{ include "agentkitmarket.fullname" . }}-secret
{{- end }}
