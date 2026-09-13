`valid.heic` is the 499-byte color-pattern HEVC fixture from
[libheif's fuzzing corpus](https://github.com/strukturag/libheif/blob/master/fuzzing/data/corpus/colors-no-alpha.heic).
It is used offline to verify actual HEVC decoding. The HEIF variant is generated
by changing only the container brands in `helpers/image-fixtures.mjs`.

JPEG, PNG, and WebP fixtures are generated locally using Sharp.
