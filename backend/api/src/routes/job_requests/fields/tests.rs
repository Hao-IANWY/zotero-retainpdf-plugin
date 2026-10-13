use super::*;

#[test]
fn apply_multipart_request_field_rejects_unknown_names() {
    // JSON 那条路上 CreateJobInput 带 deny_unknown_fields,拼错字段名会 400。
    // multipart 曾经是 `_ => {}`,同一个拼写错误在这条路上静默降级成默认值。
    // 两条入口对同一份契约的严格程度必须一致。
    let mut request = CreateJobInput::default();
    let mut developer_mode = false;
    for name in ["batchSize", "totally_unknown_field", "api_key_configured"] {
        let err = apply_multipart_request_field(&mut request, &mut developer_mode, name, "x")
            .expect_err(&format!("{name} 应该被拒绝"));
        assert!(
            format!("{err:?}").contains(name),
            "报错里要指出是哪个字段: {err:?}"
        );
    }
    // 认识的字段照常生效,别误伤。
    apply_multipart_request_field(&mut request, &mut developer_mode, "batch_size", "16")
        .expect("batch_size 是合法字段");
    assert_eq!(request.translation.batch_size, 16);
}

/// 前端在 multipart 路径上真实会发的字段名,必须全部被认识。
///
/// 这份清单取自 `frontend/packages/api/src/jobs-submit.ts` 的 appendFormField 调用。
/// `file` 不在内:它在 multipart.rs 的 `continue` 处就被取走,走不到这个函数。
#[test]
fn every_field_the_frontend_sends_is_recognized() {
    let mut request = CreateJobInput::default();
    let mut developer_mode = false;
    for name in [
        "cache_tolerance", "data_id", "disable_formula", "disable_table",
        "extra_formats", "is_ocr", "job_id", "language", "mineru_token",
        "model_version", "no_cache", "no_output_timeout_seconds",
        "ocr_credential_ref", "paddle_api_url", "paddle_model", "paddle_token",
        "page_ranges", "provider", "source_url", "upload_id", "workflow",
    ] {
        apply_multipart_request_field(&mut request, &mut developer_mode, name, "1")
            .unwrap_or_else(|err| panic!("前端会发 {name},但后端不认识: {err:?}"));
    }
    // 这两个的值必须是合法 JSON,单独给。
    apply_multipart_request_field(&mut request, &mut developer_mode, "ocr_options", "{}")
        .expect("ocr_options");
    for name in ["poll_interval", "poll_timeout", "timeout_seconds"] {
        apply_multipart_request_field(&mut request, &mut developer_mode, name, "10")
            .unwrap_or_else(|err| panic!("前端会发 {name},但后端不认识: {err:?}"));
    }
}

#[test]
fn apply_multipart_request_field_maps_flat_fields_into_grouped_input() {
    let mut request = CreateJobInput::default();
    let mut developer_mode = false;

    apply_multipart_request_field(&mut request, &mut developer_mode, "upload_id", "upload-1")
        .expect("upload_id");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "source_url",
        "https://example.com/paper.pdf",
    )
    .expect("source_url");
    apply_multipart_request_field(&mut request, &mut developer_mode, "provider", "paddle")
        .expect("provider");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "ocr_credential_ref",
        "cred-ocr",
    )
    .expect("ocr_credential_ref");
    apply_multipart_request_field(&mut request, &mut developer_mode, "mineru_token", "mineru")
        .expect("mineru_token");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "paddle_token",
        "paddle-secret",
    )
    .expect("paddle_token");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "base_url",
        "https://api.deepseek.com/v1",
    )
    .expect("base_url");
    apply_multipart_request_field(&mut request, &mut developer_mode, "api_key", "sk-test")
        .expect("api_key");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "credential_ref",
        "cred-translation",
    )
    .expect("credential_ref");
    apply_multipart_request_field(&mut request, &mut developer_mode, "render_mode", "auto")
        .expect("render_mode");
    apply_multipart_request_field(&mut request, &mut developer_mode, "timeout_seconds", "600")
        .expect("timeout_seconds");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "no_output_timeout_seconds",
        "120",
    )
    .expect("no_output_timeout_seconds");

    assert!(!developer_mode);
    assert_eq!(request.source.upload_id, "upload-1");
    assert_eq!(request.source.source_url, "https://example.com/paper.pdf");
    assert_eq!(request.ocr.provider, "paddle");
    assert_eq!(request.ocr.credential_ref, "cred-ocr");
    assert_eq!(request.ocr.mineru_token, "mineru");
    assert_eq!(request.ocr.paddle_token, "paddle-secret");
    assert_eq!(request.translation.base_url, "https://api.deepseek.com/v1");
    assert_eq!(request.translation.api_key, "sk-test");
    assert_eq!(request.translation.credential_ref, "cred-translation");
    assert_eq!(request.render.render_mode, "auto");
    assert_eq!(request.runtime.timeout_seconds, 600);
    // multipart 也必须能设空闲超时,否则 /translate/bundle 那条路的调用方
    // 根本用不上这个功能,而它们恰恰是最容易撞上"卡住不动"的同步调用。
    assert_eq!(request.runtime.no_output_timeout_seconds, 120);
}

#[test]
fn apply_multipart_request_field_parses_ocr_options() {
    let mut request = CreateJobInput::default();
    let mut developer_mode = false;

    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "ocr_options",
        r#"{"command":"python local.py","raw_provider":"generic_flat_ocr"}"#,
    )
    .expect("ocr_options");

    assert_eq!(
        request
            .ocr
            .options
            .get("command")
            .and_then(|value| value.as_str()),
        Some("python local.py")
    );
    assert_eq!(
        request
            .ocr
            .options
            .get("raw_provider")
            .and_then(|value| value.as_str()),
        Some("generic_flat_ocr")
    );
}

#[test]
fn apply_multipart_request_field_parses_glossary_fields() {
    let mut request = CreateJobInput::default();
    let mut developer_mode = false;

    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "glossary_id",
        "glossary-123",
    )
    .expect("glossary_id");
    apply_multipart_request_field(
        &mut request,
        &mut developer_mode,
        "glossary_json",
        r#"[{"source":"band gap","target":"带隙","note":"materials"}]"#,
    )
    .expect("glossary_json");

    assert_eq!(request.translation.glossary_id, "glossary-123");
    assert_eq!(request.translation.glossary_entries.len(), 1);
    assert_eq!(request.translation.glossary_entries[0].source, "band gap");
    assert_eq!(request.translation.glossary_entries[0].target, "带隙");
    assert_eq!(request.translation.glossary_entries[0].note, "materials");
}
