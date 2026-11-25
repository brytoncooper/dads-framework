//! Deterministic SplitMix64 PRNG so every DST seed reproduces identically across machines.

#[derive(Debug, Clone)]
pub struct SeededRng {
    state: u64,
}

impl SeededRng {
    pub fn new(seed: u64) -> Self {
        Self {
            state: seed.wrapping_add(0x9E37_79B9_7F4A_7C15),
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn range_usize(&mut self, bound: usize) -> usize {
        if bound <= 1 {
            return 0;
        }
        let Ok(bound_u64) = u64::try_from(bound) else {
            return 0;
        };
        let value = self.next_u64() % bound_u64;
        usize::try_from(value).unwrap_or(0)
    }

    pub fn chance(&mut self, numerator: usize, denominator: usize) -> bool {
        if denominator == 0 {
            return false;
        }
        self.range_usize(denominator) < numerator
    }

    pub fn choose<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            return None;
        }
        items.get(self.range_usize(items.len()))
    }
}
