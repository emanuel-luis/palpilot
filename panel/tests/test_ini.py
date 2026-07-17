"""Pure-stdlib tests for panel.py's OptionSettings (.ini) parser.

No network, no filesystem — these only exercise `parse_options`,
`set_options`, `_split_top_level`, and `_format_value`. panel.py is loaded
directly from its path via importlib so this works whether or not the repo
is installed as a package.
"""

import importlib.util
import os
import sys
import unittest

_PANEL_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "panel.py"
)

_spec = importlib.util.spec_from_file_location("panel_under_test", _PANEL_PATH)
panel = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = panel
_spec.loader.exec_module(panel)


class RoundTripTests(unittest.TestCase):
    def test_round_trip_stable(self):
        """parse -> set_options(with what we just parsed) -> parse again
        must yield the same options dict, and re-applying the identical
        update a second time must be a fixed point on the raw text too."""
        raw = (
            "[/Script/Pal.PalGameWorldSettings]\n"
            'OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,'
            'ServerName="My Server",bIsMultiplay=True)\n'
        )
        opts1 = panel.parse_options(raw)
        updated = panel.set_options(raw, opts1)
        opts2 = panel.parse_options(updated)
        self.assertEqual(opts1, opts2)

        updated2 = panel.set_options(updated, opts2)
        self.assertEqual(updated, updated2)

    def test_struct_and_array_values_not_mis_split(self):
        """M3: a struct/array value like Foo=(A=1,B=2) must survive as one
        pair, not get split on the comma inside the parens."""
        raw = (
            "[/Script/Pal.PalGameWorldSettings]\n"
            "OptionSettings=(Foo=(A=1,B=2),Bar=(1,2,3),Baz=3)\n"
        )
        opts = panel.parse_options(raw)
        self.assertEqual(opts.get("Foo"), "(A=1,B=2)")
        self.assertEqual(opts.get("Bar"), "(1,2,3)")
        self.assertEqual(opts.get("Baz"), "3")

    def test_string_with_comma_preserved(self):
        """A quoted string containing a comma must not be split, and must
        round-trip (still quoted) through set_options."""
        raw = (
            "[/Script/Pal.PalGameWorldSettings]\n"
            'OptionSettings=(ServerDescription="Hello, world",Difficulty=None)\n'
        )
        opts = panel.parse_options(raw)
        self.assertEqual(opts.get("ServerDescription"), "Hello, world")
        self.assertEqual(opts.get("Difficulty"), "None")

        updated = panel.set_options(raw, {"ServerDescription": opts["ServerDescription"]})
        opts2 = panel.parse_options(updated)
        self.assertEqual(opts2.get("ServerDescription"), "Hello, world")

    def test_format_value_quotes_unknown_strings_fail_safe(self):
        """Inverted quoting default (M4): anything that isn't a known
        bool/number/enum literal must come out quoted, even if it looks
        enum-like (capitalized, no spaces)."""
        self.assertEqual(panel._format_value("SomeKey", "True"), "True")
        self.assertEqual(panel._format_value("SomeKey", "42"), "42")
        self.assertEqual(panel._format_value("SomeKey", "-3.5"), "-3.5")
        self.assertEqual(panel._format_value("Difficulty", "None"), "None")
        # Not in ENUM_VALUES -> must be quoted, not passed through bare.
        self.assertEqual(panel._format_value("SomeKey", "SomeUnknownEnum"), '"SomeUnknownEnum"')
        # STRING_KEYS are always quoted, even if numeric-looking.
        self.assertEqual(panel._format_value("AdminPassword", "12345"), '"12345"')


if __name__ == "__main__":
    unittest.main()
