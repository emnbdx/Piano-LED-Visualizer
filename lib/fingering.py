"""Suggests a finger (1 = thumb ... 5 = little finger) for every note of a hand.

MIDI files carry no fingering, so it is estimated: among all the ways to finger a
passage, keep the one that costs the hand the least effort. The costs follow the usual
rules of thumb of piano teaching (comfortable spans between two fingers, passing the
thumb under, avoiding the thumb on black keys). The result is a sensible suggestion,
not a teacher's fingering.

Everything is written for the right hand; the left hand is the mirror image.
"""
from itertools import combinations

BLACK_KEYS = frozenset((1, 3, 6, 8, 10))

# For two fingers (lower number first), the distances in semitones that are relaxed,
# and the largest one a hand can reasonably reach: (relaxed min, relaxed max, limit)
SPANS = {
    (1, 2): (1, 5, 8),
    (1, 3): (3, 7, 10),
    (1, 4): (5, 9, 12),
    (1, 5): (7, 12, 14),
    (2, 3): (1, 2, 4),
    (2, 4): (3, 4, 6),
    (2, 5): (5, 7, 9),
    (3, 4): (1, 2, 3),
    (3, 5): (3, 4, 6),
    (4, 5): (1, 2, 4),
}

# After this long without a note the hand has time to move anywhere
REST_SECONDS = 1.2
# A hand plays at most this many notes at once
MAX_CHORD = 5


def _key_cost(pitch, finger):
    """Cost of a finger on a key, whatever came before."""
    if abs(pitch) % 12 in BLACK_KEYS:  # left-hand pitches arrive mirrored (negated)
        if finger == 1:
            return 2.0
        if finger == 5:
            return 1.0
    return 0.0


def _step_cost(pitch_a, finger_a, pitch_b, finger_b):
    """Cost of going from one key and finger to another (right hand)."""
    distance = pitch_b - pitch_a
    if finger_a == finger_b:
        # the same finger repeats a note for free, but has to jump to reach another
        return 0.0 if distance == 0 else 4.0 + abs(distance) * 0.5
    if distance == 0:
        return 1.0  # changing finger on a repeated note

    low, high = sorted((finger_a, finger_b))
    relaxed_min, relaxed_max, limit = SPANS[(low, high)]
    # in the natural hand position a higher finger sits on a higher key
    natural = (distance > 0) == (finger_b > finger_a)
    reach = abs(distance)

    if natural:
        if reach < relaxed_min:
            return (relaxed_min - reach) * 1.0
        if reach <= relaxed_max:
            return 0.0
        if reach <= limit:
            return (reach - relaxed_max) * 1.0
        return (limit - relaxed_max) * 1.0 + (reach - limit) * 3.0

    # Fingers crossing. Only the thumb passes under, or a finger over the thumb
    if low != 1:
        return 10.0 + reach
    cost = 2.0
    if high == 4:
        cost += 1.0
    elif high == 5:
        cost += 6.0
    if reach > 2:
        cost += (reach - 2) * 2.0
    return cost


def _chord_cost(pitches, fingers):
    """Cost of holding several keys at once."""
    cost = sum(_key_cost(pitch, finger) for pitch, finger in zip(pitches, fingers))
    if len(pitches) >= 3:
        # a full chord is framed by the thumb and the little finger when the spans allow it
        cost += 0.2 * ((fingers[0] != 1) + (fingers[-1] != 5))
    for index in range(len(pitches) - 1):
        cost += _step_cost(pitches[index], fingers[index], pitches[index + 1], fingers[index + 1])
    return cost


def _move_cost(pitches_a, fingers_a, pitches_b, fingers_b):
    """Cost of moving the hand from one group of keys to the next."""
    total = 0.0
    for pitch_a, finger_a in zip(pitches_a, fingers_a):
        for pitch_b, finger_b in zip(pitches_b, fingers_b):
            total += _step_cost(pitch_a, finger_a, pitch_b, finger_b)
    return total / (len(pitches_a) * len(pitches_b))


def suggest_fingers(notes, left_hand=False):
    """Fingers for the notes of one hand.

    notes: list of (start time in seconds, pitch), in any order.
    Returns a list of fingers in the same order; 0 where no suggestion is made (the
    extra notes of a chord of more than five).
    """
    fingers = [0] * len(notes)
    if not notes:
        return fingers

    # Notes struck together are fingered together. Mirroring the keyboard turns a left
    # hand into a right hand.
    order = sorted(range(len(notes)), key=lambda i: (notes[i][0], notes[i][1]))
    groups = []
    for index in order:
        start, pitch = notes[index]
        pitch = -pitch if left_hand else pitch
        if groups and abs(start - groups[-1]["start"]) < 0.03:
            groups[-1]["members"].append((pitch, index))
        else:
            groups.append({"start": start, "members": [(pitch, index)]})
    for group in groups:
        group["members"].sort()
        group["pitches"] = tuple(pitch for pitch, _ in group["members"][:MAX_CHORD])
        # fingers go up with the keys: every way to pick that many of the five
        group["options"] = list(combinations(range(1, 6), len(group["pitches"])))

    # Cheapest path through the groups (dynamic programming)
    best = [_chord_cost(groups[0]["pitches"], option) for option in groups[0]["options"]]
    came_from = []
    for previous, group in zip(groups, groups[1:]):
        # after a rest the previous position hardly matters any more
        weight = 0.15 if group["start"] - previous["start"] > REST_SECONDS else 1.0
        costs, links = [], []
        for option in group["options"]:
            own = _chord_cost(group["pitches"], option)
            choice, cheapest = 0, None
            for index, previous_option in enumerate(previous["options"]):
                cost = best[index] + weight * _move_cost(
                    previous["pitches"], previous_option, group["pitches"], option)
                if cheapest is None or cost < cheapest:
                    choice, cheapest = index, cost
            costs.append(cheapest + own)
            links.append(choice)
        best = costs
        came_from.append(links)

    choice = min(range(len(best)), key=best.__getitem__)
    for position in range(len(groups) - 1, -1, -1):
        group = groups[position]
        for (_, index), finger in zip(group["members"], group["options"][choice]):
            fingers[index] = finger
        if position:
            choice = came_from[position - 1][choice]
    return fingers
