from retainpdf_pipeline.ocr.document_schema.provider_adapters.paddle.content_extract import build_lines


def test_paddle_build_lines_splits_tall_body_block_into_pseudo_lines() -> None:
    bbox = [53.48, 640.259, 292.39, 699.736]
    text = (
        "Theoretical studies of the effects of substituents on absorption and emission spectra have "
        "been performed, including studies on the indigo molecule and related compounds."
    )

    lines = build_lines(
        bbox=bbox,
        segments=[],
        text=text,
        raw_label="text",
        block_type="text",
        sub_type="body",
    )

    assert len(lines) >= 3
    assert all(len(line.get("bbox", [])) == 4 for line in lines)
    assert all(line["bbox_precision"] == "synthetic_wrap" for line in lines)
    assert all(line["spans"] for line in lines)
    assert "Theoretical studies" in lines[0]["spans"][0]["text"]


def test_paddle_build_lines_marks_explicit_newlines_as_synthetic_geometry() -> None:
    lines = build_lines(
        bbox=[10.0, 20.0, 210.0, 80.0],
        segments=[],
        text="First provider line\nSecond provider line",
        raw_label="text",
        block_type="text",
        sub_type="body",
    )

    assert [line["bbox_precision"] for line in lines] == [
        "synthetic_newline",
        "synthetic_newline",
    ]
