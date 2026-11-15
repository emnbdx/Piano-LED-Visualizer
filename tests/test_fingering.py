#!/usr/bin/env python3

import sys
sys.path.append('./')
sys.path.append('../')
import unittest

from lib.fingering import suggest_fingers


def line(pitches, left_hand=False):
    return suggest_fingers([(index * 0.3, pitch) for index, pitch in enumerate(pitches)], left_hand)


def chord(pitches, left_hand=False):
    return suggest_fingers([(0, pitch) for pitch in pitches], left_hand)


C_MAJOR = [60, 62, 64, 65, 67, 69, 71, 72]


class TestFingering(unittest.TestCase):
    def test_right_hand_scale_passes_the_thumb_under(self):
        self.assertEqual(line(C_MAJOR), [1, 2, 3, 1, 2, 3, 4, 5])
        self.assertEqual(line(C_MAJOR[::-1]), [5, 4, 3, 2, 1, 3, 2, 1])

    def test_left_hand_is_the_mirror_image(self):
        self.assertEqual(line([48, 50, 52, 53, 55, 57, 59, 60], left_hand=True), [5, 4, 3, 2, 1, 3, 2, 1])

    def test_five_notes_in_a_row_use_five_fingers(self):
        self.assertEqual(line([60, 62, 64, 65, 67]), [1, 2, 3, 4, 5])

    def test_triads(self):
        self.assertEqual(chord([60, 64, 67]), [1, 3, 5])
        self.assertEqual(chord([48, 52, 55], left_hand=True), [5, 3, 1])
        self.assertEqual(chord([60, 72]), [1, 5])

    def test_thumb_avoids_black_keys_in_a_scale(self):
        d_major = [62, 64, 66, 67, 69, 71, 73, 74]
        fingers = line(d_major)
        self.assertNotIn(1, [finger for pitch, finger in zip(d_major, fingers) if pitch % 12 in (1, 3, 6, 8, 10)])

    def test_order_of_the_input_is_kept(self):
        notes = [(0.6, 64), (0.0, 60), (0.3, 62)]
        self.assertEqual(suggest_fingers(notes), [3, 1, 2])

    def test_more_than_five_notes_at_once(self):
        fingers = chord([60, 62, 64, 65, 67, 69])
        self.assertEqual(fingers[:5], [1, 2, 3, 4, 5])
        self.assertEqual(fingers[5], 0)

    def test_empty(self):
        self.assertEqual(suggest_fingers([]), [])


if __name__ == '__main__':
    unittest.main()
