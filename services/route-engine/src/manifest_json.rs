pub fn find_array<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let value = find_value(json, key)?;
    extract_balanced(value, '[', ']')
}

pub fn parse_string_field(object: &str, key: &str) -> Option<String> {
    let value = find_value(object, key)?;
    let quoted = extract_quoted(value)?;
    Some(quoted.to_owned())
}

pub fn split_array_objects(array: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let mut object_start = None;
    let mut depth = 0usize;

    for (index, ch) in array.char_indices() {
        match ch {
            '{' => {
                if depth == 0 {
                    object_start = Some(index);
                }
                depth += 1;
            }
            '}' => {
                if depth == 0 {
                    continue;
                }
                depth -= 1;
                if depth == 0 {
                    if let Some(start) = object_start.take() {
                        objects.push(&array[start..=index]);
                    }
                }
            }
            _ => {}
        }
    }

    objects
}

fn find_value<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("\"{key}\"");
    let start = json.find(&marker)? + marker.len();
    let remainder = json.get(start..)?.trim_start();
    let remainder = remainder.strip_prefix(':')?;
    Some(remainder.trim_start())
}

fn extract_balanced(value: &str, open: char, close: char) -> Option<&str> {
    let mut depth = 0usize;
    let mut start = None;

    for (index, ch) in value.char_indices() {
        if ch == open {
            if depth == 0 {
                start = Some(index);
            }
            depth += 1;
            continue;
        }

        if ch == close {
            if depth == 0 {
                return None;
            }
            depth -= 1;
            if depth == 0 {
                return start.map(|offset| &value[offset..=index]);
            }
        }
    }

    None
}

fn extract_quoted(value: &str) -> Option<&str> {
    let value = value.strip_prefix('"')?;
    let end = value.find('"')?;
    Some(&value[..end])
}
