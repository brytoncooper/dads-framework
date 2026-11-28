use crate::workspace::porcelain_status_is_clean_for_head;

#[test]
fn head_clean_allows_empty_or_untracked_manifest_only() {
    assert!(porcelain_status_is_clean_for_head(b"", None));
    assert!(porcelain_status_is_clean_for_head(
        b"?? dads.testing.json\0",
        None
    ));
    assert!(porcelain_status_is_clean_for_head(
        b"?? config/testing.json\0",
        Some("./config/testing.json")
    ));
    assert!(!porcelain_status_is_clean_for_head(
        b" M dads.testing.json\0",
        None
    ));
    assert!(!porcelain_status_is_clean_for_head(
        b"?? dads.testing.json\0?? src/extra.ts\0",
        None
    ));
    assert!(!porcelain_status_is_clean_for_head(
        b"R  a.ts\0b.ts\0",
        None
    ));
}
