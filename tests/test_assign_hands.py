#!/usr/bin/env python3

import sys
sys.path.append('./')
sys.path.append('../')
import unittest

import mido

from lib.learnmidi import assign_hands


def track(*notes):
    t = mido.MidiTrack()
    for note in notes:
        t.append(mido.Message('note_on', note=note, velocity=64, channel=5, time=0))
        t.append(mido.Message('note_off', note=note, velocity=64, channel=5, time=120))
    return t


def channels(mid):
    return [[m.channel for m in t if m.type == 'note_on'] for t in mid.tracks]


class TestAssignHands(unittest.TestCase):
    def test_two_tracks_are_right_then_left(self):
        mid = mido.MidiFile()
        mid.tracks.extend([track(72, 76), track(40, 43)])
        assign_hands(mid)
        self.assertEqual(channels(mid), [[1, 1], [2, 2]])

    def test_tempo_track_then_two_hands(self):
        mid = mido.MidiFile()
        tempo = mido.MidiTrack([mido.MetaMessage('set_tempo', tempo=500000)])
        mid.tracks.extend([tempo, track(72), track(40)])
        assign_hands(mid)
        self.assertEqual(channels(mid), [[], [1], [2]])

    def test_single_track_is_split_at_middle_c(self):
        # e.g. a recording made with the visualizer
        mid = mido.MidiFile()
        mid.tracks.append(track(59, 60, 30, 100))
        assign_hands(mid)
        self.assertEqual(channels(mid), [[2, 1, 2, 1]])

    def test_note_off_velocity_is_cleared(self):
        mid = mido.MidiFile()
        mid.tracks.append(track(60))
        assign_hands(mid)
        self.assertEqual([m.velocity for m in mid.tracks[0] if m.type == 'note_off'], [0])


if __name__ == '__main__':
    unittest.main()
