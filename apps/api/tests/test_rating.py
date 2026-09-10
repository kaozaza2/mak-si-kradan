from makthai.rating import DEFAULT_RATING, RatingInput, compute_changes, expected_score, k_factor


def player(rating=DEFAULT_RATING, score=0, retired=False, games_played=0):
    return RatingInput(rating=rating, score=score, retired=retired, games_played=games_played)


def test_เรตติ้งเท่ากันมีโอกาสชนะครึ่งต่อครึ่ง():
    assert expected_score(1200, 1200) == 0.5
    assert expected_score(1600, 1200) > 0.9
    assert expected_score(1200, 1600) < 0.1


def test_ตัวคูณลดลงเมื่อเล่นเยอะขึ้นและเรตติ้งสูงขึ้น():
    assert k_factor(DEFAULT_RATING, 0) == 32
    assert k_factor(DEFAULT_RATING, 50) == 24
    assert k_factor(2100, 50) == 16


def test_ชนะได้แต้ม_แพ้เสียแต้ม_และผลรวมเป็นศูนย์():
    winner, loser = compute_changes([player(score=30), player(score=20)])
    assert winner.delta == 16
    assert loser.delta == -16
    assert winner.outcome == "win"
    assert loser.outcome == "loss"


def test_ชนะคนเรตติ้งสูงกว่าได้แต้มเยอะกว่า():
    underdog = compute_changes([player(1200, 30), player(1800, 20)])[0]
    favourite = compute_changes([player(1800, 30), player(1200, 20)])[0]
    assert underdog.delta > favourite.delta
    assert favourite.delta < 5


def test_คะแนนเท่ากันคือเสมอ():
    changes = compute_changes([player(score=25), player(score=25)])
    assert [c.delta for c in changes] == [0, 0]
    assert all(c.outcome == "draw" for c in changes)


def test_เกมสี่คนเรียงลำดับแต้มตามอันดับที่ทำได้():
    changes = compute_changes(
        [player(score=30), player(score=20), player(score=15), player(score=5)]
    )
    assert changes[0].delta > changes[1].delta > changes[2].delta
    assert changes[3].delta < 0
    # ระบบผลรวมเป็นศูนย์ คลาดได้เล็กน้อยจากการปัดเศษ
    assert abs(sum(c.delta for c in changes)) <= 2


def test_ถอนตัวกลางคันถือว่าแพ้แม้คะแนนนำ():
    changes = compute_changes([player(score=50, retired=True), player(score=1)])
    assert changes[0].delta < 0
    assert changes[0].outcome == "loss"
    assert changes[1].outcome == "win"


def test_ผู้เล่นคนเดียวไม่มีอะไรให้คิด():
    assert compute_changes([player(score=10)])[0].delta == 0
