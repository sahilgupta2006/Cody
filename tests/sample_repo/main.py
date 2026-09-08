from utils import helper as h
from pkg.core import Foo


def process():
    return h()


def main():
    f = Foo()
    f.bar()
    return process()


if __name__ == "__main__":
    main()
