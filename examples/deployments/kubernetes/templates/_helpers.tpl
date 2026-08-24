{{/* SPDX-License-Identifier: Apache-2.0 */}}

{{- define "askturret-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "askturret-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "askturret-mcp.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "askturret-mcp.labels" -}}
app.kubernetes.io/name: {{ include "askturret-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "askturret-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "askturret-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
