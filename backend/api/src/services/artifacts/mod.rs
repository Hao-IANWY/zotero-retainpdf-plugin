mod bundle;
mod presentation;
mod registry;
mod response;
mod titles;

pub use bundle::{build_bundle_for_job, build_markdown_bundle_for_job};
pub(crate) use presentation::build_artifacts_display;
pub use registry::{find_registry_artifact, list_registry_for_job, resolve_registry_artifact};
pub use response::{artifact_is_direct_downloadable, artifact_resource_path};
pub(crate) use titles::{
    document_title, document_titles_for, job_display_title, source_url_file_name, DocumentTitles,
};

#[cfg(test)]
mod tests;
